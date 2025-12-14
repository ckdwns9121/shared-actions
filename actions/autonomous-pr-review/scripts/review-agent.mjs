import { query as streamQuery } from "@anthropic-ai/claude-agent-sdk";
import { Octokit } from "@octokit/rest";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing`);
  return v;
}

must("ANTHROPIC_API_KEY");
const token = must("BOT_TOKEN");
const repoFull = must("REPO"); // owner/repo
const prNumber = Number(must("PR_NUMBER"));

const replyStyle = process.env.REPLY_STYLE || "요약 / 중요한 이슈 / 개선 제안 / 테스트 제안";
const model = process.env.MODEL || "claude-sonnet-4-20250514";
const permissionMode = process.env.PERMISSION_MODE || "bypassPermissions";
const maxTurns = Number(process.env.MAX_TURNS || "40");
const allowedTools = process.env.ALLOWED_TOOLS
  ? process.env.ALLOWED_TOOLS.split(",").map((name) => name.trim()).filter(Boolean)
  : undefined;
const allowDangerouslySkipPermissions = permissionMode === "bypassPermissions";

async function autoApproveToolRequest(_toolName, input) {
  return {
    behavior: "allow",
    updatedInput: typeof input === "object" && input !== null ? input : {},
  };
}

const [owner, repo] = repoFull.split("/");
if (!owner || !repo) throw new Error(`REPO must be "owner/repo": got ${repoFull}`);
if (!Number.isFinite(prNumber) || prNumber <= 0) throw new Error(`PR_NUMBER invalid: ${process.env.PR_NUMBER}`);

const octokit = new Octokit({ auth: token });
const githubMcpToken = process.env.MCP_TOKEN || token;
const githubMcpServers = githubMcpToken
  ? {
      github: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/github"],
        env: {
          GITHUB_TOKEN: githubMcpToken,
        },
      },
    }
  : undefined;

function extractTextBlocks(message) {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function postComment(body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

function isAnthropicCreditError(err) {
  const msg = err?.error?.error?.message || err?.message || "";
  return msg.toLowerCase().includes("credit balance is too low");
}

function isAnthropicModelNotFound(err) {
  const msg = err?.error?.error?.message || err?.message || "";
  return msg.toLowerCase().includes("model:") && msg.toLowerCase().includes("not_found");
}

async function runClaudeReview(prompt) {
  const stream = streamQuery({
    prompt,
    model,
    mcpServers: githubMcpServers,
    allowedTools,
    permissionMode,
    maxTurns,
    persistSession: false,
    canUseTool: autoApproveToolRequest,
    allowDangerouslySkipPermissions: allowDangerouslySkipPermissions || undefined,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        "You are an autonomous senior engineer operating inside GitHub Actions.",
        "Use the available GitHub MCP tools to inspect the pull request, its files, and diffs.",
        "Run whatever built-in tools you need without asking for confirmation.",
        `최종 답변은 한국어로 작성하고 "${replyStyle}" 구조를 참고해 핵심 요약, 주요 이슈, 개선안, 테스트 제안을 포함해라.`,
      ].join(" "),
    },
  });

  let finalOutput = "";
  let assistantFallback = "";

  for await (const message of stream) {
    if (message.type === "assistant") {
      const text = extractTextBlocks(message.message);
      if (text) assistantFallback = text;
    }

    if (message.type === "result") {
      if (message.subtype === "success" && !message.is_error) {
        finalOutput = message.result?.trim() || "";
        break;
      }

      const reason = message.errors?.join("\n") || `Agent run failed with subtype ${message.subtype}`;
      throw new Error(reason);
    }
  }

  return finalOutput || assistantFallback;
}

async function main() {
  const userPrompt = `
당신은 GitHub Action 안에서 ${repoFull} 저장소의 PR #${prNumber}를 리뷰하는 자율 에이전트다.
- 반드시 GitHub MCP 도구를 이용해 PR 제목, 설명, 변경 파일, diff를 직접 조사해라.
- 변경 파일마다 문제가 발견되면 GitHub CLI(\`gh pr review --comment\`)나 GitHub MCP의 리뷰 작성 도구를 사용해 해당 파일/라인에 인라인 코멘트를 남겨라.
- 문서(.md)만 수정된 경우라도 변경 목적이 PR 제목과 일치하는지 확인하고, 불일치 시 인라인 또는 일반 코멘트로 지적해라.
- 가능한 경우 코드 예시, 수정 방법, 필요 테스트를 각 코멘트에 포함해라.
- 모든 인라인 코멘트를 남긴 후, 최종 답변에서는 전체 요약/주요 이슈/개선 제안/추가 테스트 아이디어를 한국어로 제공하되 이미 남긴 인라인 코멘트 내용을 중복하지 말고 전체 맥락을 정리해라.
- 어떤 도구를 썼는지, 남긴 코멘트 수, 추가로 실행해야 할 검증 절차를 마지막 문단에 정리해라.
`.trim();

  const text = await runClaudeReview(userPrompt);

  if (!text) {
    await postComment("리뷰 결과를 생성하지 못했습니다. (빈 응답)");
    return;
  }

  await postComment(text);
}

main().catch(async (err) => {
  console.error(err);
  const requestId = err?.requestID || err?.request_id || err?.error?.request_id || null;
  const baseMsg = err?.error?.error?.message || err?.message || "Unknown error";

  if (isAnthropicCreditError(err)) {
    await postComment(
      `⚠️ 리뷰봇이 Anthropic API를 호출하지 못했습니다: **크레딧 부족**\n\n` +
        `- 메시지: ${baseMsg}\n` +
        (requestId ? `- request_id: ${requestId}\n` : "") +
        `\n👉 Anthropic Console의 Plans & Billing에서 크레딧을 충전/결제 설정해주세요.`
    );
    process.exit(0);
  }

  if (isAnthropicModelNotFound(err)) {
    await postComment(
      `⚠️ 리뷰봇이 Anthropic API를 호출하지 못했습니다: **모델을 찾을 수 없음**\n\n` +
        `- 요청 모델: \`${process.env.MODEL}\`\n` +
        `- 메시지: ${baseMsg}\n` +
        (requestId ? `- request_id: ${requestId}\n` : "") +
        `\n👉 workflow input의 \`model\` 값을 사용 가능한 모델로 바꿔주세요.`
    );
    process.exit(0);
  }

  await postComment(
    `⚠️ 리뷰봇 실행 중 오류가 발생했습니다.\n\n` +
      `- 메시지: ${baseMsg}\n` +
      (requestId ? `- request_id: ${requestId}\n` : "") +
      `\n(상세 로그는 Actions 실행 로그를 확인해주세요.)`
  );
  process.exit(0);
});
