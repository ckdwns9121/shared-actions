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
const model = process.env.MODEL || "claude-sonnet-4-20250514";
const maxDiffChars = Number(process.env.MAX_DIFF_CHARS || "30000");

const [owner, repo] = repoFull.split("/");
if (!owner || !repo) throw new Error(`REPO must be "owner/repo": got ${repoFull}`);
if (!Number.isFinite(prNumber) || prNumber <= 0) throw new Error(`PR_NUMBER invalid: ${process.env.PR_NUMBER}`);

const anthropic = new Anthropic({ apiKey });
const octokit = new Octokit({ auth: token });

function clip(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...(truncated)...";
}

async function fetchPR() {
  const prRes = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return prRes.data;
}

async function fetchPRDiff() {
  const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
    headers: { accept: "application/vnd.github.v3.diff" },
  });

  if (typeof diffRes.data === "string") return diffRes.data;
  return JSON.stringify(diffRes.data);
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

async function tryListModelsForHint() {
  try {
    const res = await anthropic.models.list();
    const ids = (res?.data || []).map((m) => m.id).slice(0, 20);
    if (!ids.length) return null;
    return ids;
  } catch {
    return null;
  }
}

async function main() {
  const pr = await fetchPR();
  const diff = await fetchPRDiff();

  const clippedDiff = clip(diff, maxDiffChars);

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
${pr.title ?? ""}

[PR 설명]
${pr.body ?? ""}

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

  const text = (resp.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!text) {
    await postComment("리뷰 결과를 생성하지 못했습니다. (빈 응답)");
    return;
  }

  await postComment(text);
}

main().catch(async (err) => {
  // ✅ 실패해도 PR에 이유를 남기고, workflow는 실패로 만들지 않게(운영 편함)
  const requestId = err?.requestID || err?.request_id || err?.error?.request_id || null;
  const baseMsg = err?.error?.error?.message || err?.message || "Unknown error";

  // 크레딧 부족
  if (isAnthropicCreditError(err)) {
    await postComment(
      `⚠️ 리뷰봇이 Anthropic API를 호출하지 못했습니다: **크레딧 부족**\n\n` +
        `- 메시지: ${baseMsg}\n` +
        (requestId ? `- request_id: ${requestId}\n` : "") +
        `\n👉 Anthropic Console의 Plans & Billing에서 크레딧을 충전/결제 설정해주세요.`
    );
    process.exit(0);
  }

  // 모델 못 찾음(권한/존재 안 함)
  if (String(baseMsg).includes("model:")) {
    const models = await tryListModelsForHint();
    await postComment(
      `⚠️ 리뷰봇이 Anthropic API를 호출하지 못했습니다: **모델을 찾을 수 없음**\n\n` +
        `- 요청 모델: \`${process.env.MODEL}\`\n` +
        `- 메시지: ${baseMsg}\n` +
        (requestId ? `- request_id: ${requestId}\n` : "") +
        (models ? `\n✅ 이 키에서 보이는 모델 예시:\n- ${models.map((m) => `\`${m}\``).join("\n- ")}\n` : "") +
        `\n👉 workflow input의 \`model\` 값을 위 목록 중 하나로 바꿔주세요.`
    );
    process.exit(0);
  }

  // 기타 에러
  await postComment(
    `⚠️ 리뷰봇 실행 중 오류가 발생했습니다.\n\n` +
      `- 메시지: ${baseMsg}\n` +
      (requestId ? `- request_id: ${requestId}\n` : "") +
      `\n(상세 로그는 Actions 실행 로그를 확인해주세요.)`
  );
  process.exit(0);
});
