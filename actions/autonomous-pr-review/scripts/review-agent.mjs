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

const reviewOutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      comments: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "line", "body"],
          properties: {
            path: { type: "string" },
            line: { type: "number" },
            side: { type: "string", enum: ["RIGHT", "LEFT"] },
            body: { type: "string" },
            severity: { type: "string" },
          },
        },
      },
    },
    required: ["comments"],
  },
};

function normalizeReviewResult(structured, fallbackText) {
  if (!structured && !fallbackText) return null;

  const comments = Array.isArray(structured?.comments)
    ? structured.comments
        .map((comment) => {
          const path = typeof comment.path === "string" ? comment.path.trim() : "";
          const line = Number(comment.line);
          const body = typeof comment.body === "string" ? comment.body.trim() : "";
          const side = comment.side === "LEFT" ? "LEFT" : "RIGHT";
          const severity = typeof comment.severity === "string" ? comment.severity.trim() : "";
          return { path, line, body, side, severity };
        })
        .filter((comment) => comment.path && Number.isFinite(comment.line) && comment.line > 0 && comment.body)
    : [];

  const summary =
    typeof structured?.summary === "string" && structured.summary.trim().length > 0
      ? structured.summary.trim()
      : fallbackText?.trim() || "";

  if (comments.length === 0 && !summary) {
    return null;
  }

  return { summary, comments };
}

async function postReviewComments(review) {
  if (!review?.comments?.length) throw new Error("No review comments to post");

  const comments = review.comments.map((comment) => {
    const decoratedBody = comment.severity ? `(${comment.severity}) ${comment.body}` : comment.body;
    return {
      path: comment.path,
      line: comment.line,
      side: comment.side || "RIGHT",
      body: decoratedBody,
    };
  });

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "COMMENT",
    body: review.summary || "자동 코드 리뷰",
    comments,
  });
}

async function runClaudeReview(prompt) {
  const stream = query({
    prompt,
    options: {
      model,
      permissionMode: "plan",
      persistSession: false,
      tools: [],
      outputFormat: reviewOutputFormat,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "You run inside a CI workflow as a senior code reviewer.",
          "Never execute tools or make filesystem changes.",
          `모든 응답은 한국어 JSON으로 작성하고 summary에는 "${replyStyle}" 구조를 압축해서 담아라.`,
          "각 comment.body에는 해당 변경의 문제 설명, 심각도(High/Med/Low), 구체적 수정안, 테스트 제안을 포함해라.",
          "Return JSON that lists summary and per-file comments with file path and head line numbers.",
        ].join(" "),
      },
    },
  });

  let finalOutput = "";
  let assistantFallback = "";
  let structuredOutput = null;

  for await (const message of stream) {
    if (message.type === "assistant") {
      const text = extractTextBlocks(message.message);
      if (text) assistantFallback = text;
    }

    if (message.type === "result") {
      if (message.subtype === "success" && !message.is_error) {
        structuredOutput = message.structured_output ?? null;
        finalOutput = message.result?.trim() || "";
        break;
      }

      const reason = message.errors?.join("\n") || `Agent run failed with subtype ${message.subtype}`;
      throw new Error(reason);
    }
  }

  return { structured: structuredOutput, fallbackText: finalOutput || assistantFallback };
}

async function main() {
  const pr = await fetchPR();
  const diff = await fetchPRDiff();

  const clippedDiff = clip(diff, maxDiffChars);

  const userPrompt = `
아래는 GitHub Pull Request 정보다.
- diff에 없는 사실은 추측하지 말고, 반드시 근거가 되는 변경 라인과 파일을 명시해라.
- 각 문제는 하이라이트(High/Med/Low)를 포함한 심각도와 구체적인 수정 가이드를 제시해라.
- 응답은 한국어 JSON 객체 형식으로만 작성해라.
- JSON 형식 예시: {"summary": "<전체 요약>", "comments": [{"path": "src/file.ts", "line": 42, "side": "RIGHT", "severity": "High", "body": "구체적 지적 및 테스트 제안"}]}
- comments 배열에는 diff에서 문제가 있는 각 변경사항에 대한 리뷰를 넣어라. 최소 1개 이상이 되도록 노력해라.
- summary에는 PR 전체 요약과 전반적인 테스트 제안을 담아라.

[PR 제목]
${pr.title ?? ""}

[PR 설명]
${pr.body ?? ""}

[PR Diff]
${clippedDiff}
`.trim();

  const { structured, fallbackText } = await runClaudeReview(userPrompt);
  const review = normalizeReviewResult(structured, fallbackText);

  if (!review) {
    await postComment("리뷰 결과를 생성하지 못했습니다. (빈 응답)");
    return;
  }

  if (review.comments.length > 0) {
    await postReviewComments(review);
    return;
  }

  await postComment(review.summary || "리뷰 결과를 생성하지 못했습니다. (요약 없음)");
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
