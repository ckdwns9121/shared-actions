import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const prNumber = Number(process.env.PR_NUMBER);
const repoFull = process.env.REPO; // "owner/repo"
const botToken = process.env.BOT_TOKEN;
const replyStyle = process.env.REPLY_STYLE || "요약 / 중요한 이슈 / 개선 제안 / 테스트 제안";

if (!repoFull || !repoFull.includes("/")) throw new Error("REPO is missing or invalid (expected owner/repo)");
if (!Number.isFinite(prNumber) || prNumber <= 0) throw new Error("PR_NUMBER is missing or invalid");
if (!botToken) throw new Error("BOT_TOKEN is missing");

const [owner, repo] = repoFull.split("/");
const octokit = new Octokit({ auth: botToken });

// GitHub MCP-like tools (custom tools)
const githubTools = createSdkMcpServer({
  name: "github",
  version: "1.0.0",
  tools: [
    tool(
      "get_pr_files_with_patches",
      "List changed files in a PR with patches (when available).",
      { prNumber: z.number() },
      async ({ prNumber }) => {
        const files = await octokit.paginate(octokit.pulls.listFiles, {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        });

        const payload = files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch ?? null,
        }));

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }
    ),

    tool(
      "post_pr_comment",
      "Post a single summary comment to the PR (issue comment).",
      { prNumber: z.number(), body: z.string().min(1).max(65000) },
      async ({ prNumber, body }) => {
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
        return { content: [{ type: "text", text: "OK" }] };
      }
    ),
  ],
});

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content: `
너는 시니어 코드 리뷰어다. 이 PR을 "자율적으로" 리뷰해라.

절차:
1) get_pr_files_with_patches로 변경 파일/패치를 확인한다.
2) 더 깊게 확인이 필요하면 워크스페이스 파일을 Read/Grep/Glob로 찾아 읽는다.
3) 아래 형식으로 리뷰를 작성한다:
   ${replyStyle}
4) 마지막에 post_pr_comment로 PR에 "댓글 1개"만 남긴다. (라인 코멘트 X)

추가 규칙:
- 토큰/시크릿은 절대 출력하지 마.
- 코드 수정(Edit)/커밋/푸시는 절대 하지 마.
- 불확실하면 "확인 필요"로 남기고 근거를 설명해.

PR 번호: ${prNumber}
레포: ${owner}/${repo}
`.trim(),
    },
  };
}

const allowedTools = [
  // workspace inspection (caller repo is checked out by workflow)
  "Read",
  "Grep",
  "Glob",

  // our GitHub tools
  "mcp__github__get_pr_files_with_patches",
  "mcp__github__post_pr_comment",
];

for await (const _msg of query({
  prompt: prompt(),
  options: {
    mcpServers: { github: githubTools },
    allowedTools,
    maxTurns: 10,
    systemPrompt: "You are a careful PR reviewer. Do not modify code. Only produce a single summary PR comment.",
  },
})) {
  // If you want streaming debug output:
  // console.log(JSON.stringify(_msg));
}
