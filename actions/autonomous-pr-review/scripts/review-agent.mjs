import { Octokit } from "@octokit/rest";
import { query } from "@anthropic-ai/claude-agent-sdk";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const BOT_TOKEN = mustEnv("BOT_TOKEN");
const REPO = mustEnv("REPO"); // e.g. ckdwns9121/blog
const PR_NUMBER = Number(mustEnv("PR_NUMBER"));
const REPLY_STYLE = process.env.REPLY_STYLE ?? "요약 / 중요한 이슈 / 개선 제안 / 테스트 제안";

const [owner, repo] = REPO.split("/");
if (!owner || !repo) throw new Error(`Invalid REPO: ${REPO}`);

const octokit = new Octokit({ auth: BOT_TOKEN });

async function getPullRequestDiff() {
  // PR diff 가져오기 (큰 repo에서 grep 안 돌게 만드는 핵심)
  const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: PR_NUMBER,
    headers: { accept: "application/vnd.github.v3.diff" },
  });

  // PR 메타도 같이
  const prRes = await octokit.pulls.get({ owner, repo, pull_number: PR_NUMBER });

  return {
    title: prRes.data.title ?? "",
    body: prRes.data.body ?? "",
    diff: diffRes.data ?? "",
  };
}

async function commentToPR(body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: PR_NUMBER,
    body,
  });
}

async function run() {
  const { title, body, diff } = await getPullRequestDiff();

  const prompt = `
너는 시니어 프론트엔드/풀스택 코드리뷰어야.
아래 PR 정보를 바탕으로 **코드리뷰 코멘트**를 한국어로 작성해줘.

[출력 포맷]
${REPLY_STYLE}

[주의]
- diff에 없는 내용은 추측하지 마.
- 확실하지 않으면 "추정"이라고 표시해.
- 코멘트는 PR 작성자가 바로 수정할 수 있게 구체적으로.
- 가능하면 "왜"와 "어떻게"를 함께 제시.

[PR 제목]
${title}

[PR 설명]
${body}

[PR Diff]
${diff}
`.trim();

  // ✅ 핵심: Claude Code(Agent SDK) 쪽이 repo 전체를 grep/scan 하다 죽는 케이스가 있어서
  // 최대한 "도구 사용 없이" 1턴으로 끝내는 설정으로 안정화
  const options = {
    maxTurns: 1,
    // cwd를 workspace로 고정 (Actions에서 코드가 있는 위치)
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(), // Options.cwd 문서에 있음 :contentReference[oaicite:1]{index=1}
    // stderr를 그대로 찍어서 다음부터 원인 파악 가능
    stderr: (data) => process.stderr.write(data), // Options.stderr 문서에 있음 :contentReference[oaicite:2]{index=2}
    // 도구를 최소화 (Grep/Glob 같은 걸 못 쓰게 해서 exit 1 회피)
    disallowedTools: ["Grep", "Glob"], // allowed/disallowed tools 옵션 문서 :contentReference[oaicite:3]{index=3}
    // 디버그 더 보고 싶으면 CLI 플래그도 전달 가능(예: --debug) :contentReference[oaicite:4]{index=4}
    extraArgs: { debug: null },
  };

  let finalText = "";
  for await (const msg of query({ prompt, options })) {
    // SDKMessage 구조가 다양해서, 안전하게 text만 누적하는 방식
    if (msg.type === "assistant" && typeof msg.content === "string") {
      finalText += msg.content;
    }
  }

  if (!finalText.trim()) {
    finalText = "리뷰 결과를 생성하지 못했습니다. (로그를 확인해주세요)";
  }

  await commentToPR(finalText);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
