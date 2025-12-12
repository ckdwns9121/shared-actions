import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing`);
  return v;
}

const apiKey = must("ANTHROPIC_API_KEY");
const token = must("BOT_TOKEN");
const repoFull = must("REPO"); // owner/repo
const prNumber = Number(must("PR_NUMBER"));
const replyStyle = process.env.REPLY_STYLE || "요약 / 중요한 이슈 / 개선 제안 / 테스트 제안";
const model = process.env.MODEL || "claude-3-5-sonnet-latest";

const [owner, repo] = repoFull.split("/");
if (!owner || !repo) throw new Error(`REPO must be "owner/repo": got ${repoFull}`);
if (!Number.isFinite(prNumber) || prNumber <= 0) throw new Error(`PR_NUMBER invalid: ${process.env.PR_NUMBER}`);

const anthropic = new Anthropic({ apiKey });
const octokit = new Octokit({ auth: token });

async function fetchPRDiff() {
  // diff는 accept 헤더로 받는 게 가장 깔끔
  const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
    headers: { accept: "application/vnd.github.v3.diff" },
  });

  const prRes = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    title: prRes.data.title ?? "",
    body: prRes.data.body ?? "",
    diff: typeof diffRes.data === "string" ? diffRes.data : JSON.stringify(diffRes.data),
  };
}

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...(truncated)...";
}

async function postComment(body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

async function main() {
  const { title, body, diff } = await fetchPRDiff();

  // 너무 큰 diff면 자르기 (토큰/비용/에러 방지)
  const clippedDiff = clip(diff, 30000);

  const userPrompt = `
너는 시니어 코드 리뷰어다. 아래 PR diff를 바탕으로 리뷰 코멘트를 한국어로 작성해라.

출력 형식:
${replyStyle}

규칙:
- diff에 없는 내용은 추측하지 마라.
- 심각도(High/Med/Low)를 표시해라.
- 가능한 경우 "대안 코드" 또는 "구체적인 수정 방법"을 제시해라.
- 마지막에 "테스트 제안"을 포함해라.

[PR 제목]
${title}

[PR 설명]
${body}

[PR Diff]
${clippedDiff}
`.trim();

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 1200,
    temperature: 0,
    system: "You are a careful senior engineer. Be concise but actionable.",
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Claude returned empty response");

  await postComment(text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
