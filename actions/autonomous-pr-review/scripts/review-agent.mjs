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

function logAgentMessage(message) {
  try {
    if (!message) return;
    if (message.type === "assistant") {
      const text = extractTextBlocks(message.message);
      console.log("[Agent][assistant]", text || JSON.stringify(message.message));
      return;
    }
    if (message.type === "tool_call" || message.type === "tool_result") {
      console.log("[Agent][" + message.type + "]", JSON.stringify(message, null, 2));
      return;
    }
    if (message.type === "result") {
      console.log("[Agent][result]", JSON.stringify(message, null, 2));
      return;
    }
    console.log("[Agent][" + (message.type || "unknown") + "]", JSON.stringify(message, null, 2));
  } catch (err) {
    console.error("[Agent][log_error]", err);
  }
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

async function fetchLatestUserRequest() {
  try {
    const commentsRes = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const comments = commentsRes.data ?? [];
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const body = comments[i]?.body || "";
      if (!body) continue;
      const mentionIndex = body.toLowerCase().indexOf("@review-bot");
      if (mentionIndex === -1) continue;
      const instructions = body.slice(mentionIndex + "@review-bot".length).trim();
      if (instructions) return instructions;
    }
    return null;
  } catch (err) {
    console.warn("[Agent] Failed to fetch user request:", err);
    return null;
  }
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
    outputFormat: reviewOutputFormat,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        "You are an autonomous senior engineer operating inside GitHub Actions.",
        "Use local inputs first; if additional context is needed, use GitHub MCP tools.",
        "Return JSON with summary/comments per the schema, do not emit free-form text outside the schema.",
        `summary는 한국어로 "${replyStyle}" 구조를 따르고 각 comment에는 파일 경로/라인/심각도/수정안/테스트 제안을 포함해라.`,
      ].join(" "),
    },
  });

  let finalOutput = "";
  let assistantFallback = "";
  let structuredOutput = null;

  for await (const message of stream) {
    logAgentMessage(message);
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
  const userRequest = await fetchLatestUserRequest();
  const userRequestBlock = userRequest
    ? `사용자 추가 지시사항:\n${userRequest}\n- 위 요구사항을 가능한 한 충실히 반영해라.`
    : "사용자 추가 지시사항: (추가 요청 없음)";

  const userPrompt = `
당신은 GitHub Action 안에서 ${repoFull} 저장소의 PR #${prNumber}를 리뷰하는 자율 에이전트다.
${userRequestBlock}
- GitHub MCP 도구(예: pull_request.get, pull_request.files, pull_request.diff 등)를 사용해 PR 제목, 설명, 변경 파일, diff를 직접 조사해라.
- summary는 한국어로 "${replyStyle}" 순서를 따르며 전체 요약/주요 이슈/개선안/테스트 제안을 포함해야 한다.
- comments 배열에는 각 문제에 대한 구체적 리뷰를 넣고 path/line/side/severity/body 필드를 채워라. body에는 문제 설명, 원인, 수정안, 필요한 테스트를 모두 서술해라.
- PR 제목/설명과 실제 변경 내용이 다르면 summary에서 지적하고, 모든 사실은 MCP로 확인한 내용만 사용해라.
- JSON 스키마를 반드시 지키고, free-form 텍스트는 summary/body 필드 외에 쓰지 마라.
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
