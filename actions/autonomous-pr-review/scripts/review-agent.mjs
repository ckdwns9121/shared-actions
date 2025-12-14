import { query } from "@anthropic-ai/claude-agent-sdk";
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
const maxDiffChars = Number(process.env.MAX_DIFF_CHARS || "30000");

const [owner, repo] = repoFull.split("/");
if (!owner || !repo) throw new Error(`REPO must be "owner/repo": got ${repoFull}`);
if (!Number.isFinite(prNumber) || prNumber <= 0) throw new Error(`PR_NUMBER invalid: ${process.env.PR_NUMBER}`);

const octokit = new Octokit({ auth: token });

function clip(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...(truncated)...";
}

function extractTextBlocks(message) {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
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

async function runClaudeReview(prompt) {
  const stream = query({
    prompt,
    options: {
      model,
      permissionMode: "plan",
      persistSession: false,
      tools: [],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "You run inside a CI workflow as a senior code reviewer.",
          "Never execute tools or make filesystem changes.",
          "All answers must be in Korean and follow this template:",
          replyStyle,
          "Highlight severity (High/Med/Low) and concrete fixes.",
          "Always end with explicit 테스트 제안.",
        ].join(" "),
      },
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

      const reason =
        message.errors?.join("\n") ||
        `Agent run failed with subtype ${message.subtype}`;
      throw new Error(reason);
    }
  }

  return finalOutput || assistantFallback;
}

async function main() {
  const pr = await fetchPR();
  const diff = await fetchPRDiff();

  const clippedDiff = clip(diff, maxDiffChars);

  const userPrompt = `
아래 정보는 GitHub Pull Request 컨텍스트다.
코드 diff에 없는 사실은 추측하지 말고, 문제를 지적할 때는 근거가 되는 코드 조각/파일을 명확히 언급해라.
가능한 경우 바로 적용할 수 있는 수정 지침 또는 예시 코드를 제공해라.
응답은 반드시 한국어로 작성하고, 아래 출력 템플릿을 그대로 사용해라.

출력 템플릿:
${replyStyle}

[PR 제목]
${pr.title ?? ""}

[PR 설명]
${pr.body ?? ""}

[PR Diff]
${clippedDiff}
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
