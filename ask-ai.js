// Cloudflare Pages Function - 대시보드에서 "현재 필터링된 데이터"에 대해서만 답하는 AI 질의 프록시.
//
// [설치 방법]
// 1. 이 파일을 웹배포 저장소(github)의 "functions/api/ask-ai.js" 경로 그대로 커밋 -> git push
//    (Cloudflare Pages는 functions/ 폴더를 자동으로 서버리스 API로 인식합니다. 별도 서버 설정 필요없음)
// 2. Cloudflare 대시보드 -> Pages 프로젝트 -> Settings -> Environment variables 에서
//    이름 GEMINI_API_KEY, 값은 아래에서 발급받은 키를 등록 (Production/Preview 둘 다 추가)
//    키 발급: https://aistudio.google.com/apikey (구글 계정으로 무료 발급)
// 3. 다시 배포되면 대시보드 페이지의 "AI에게 물어보기" 버튼이 이 함수를 호출합니다.
//
// [왜 이렇게 만들었는지]
// - API 키를 브라우저(JS) 코드에 직접 넣지 않고 이 서버 함수 안에서만 씀 - 페이지 소스를 봐도
//   키가 보이지 않음.
// - 화면에 필터링된 데이터만 받아서(최대 MAX_ROWS건) 프롬프트에 넣음 - 전체 수백 건을 매번
//   보내지 않아 비용/속도를 아낌. 질문도 길이를 제한해서 과도한 호출을 막음.
// - 프롬프트 자체에 "주어진 데이터에만 근거해서 답하라"고 명시해서, 데이터에 없는 걸 지어내는
//   것을 최대한 막음(완전히 막을 수는 없으니 참고용으로만 활용 권장).

const MODEL = "gemini-2.0-flash"; // 무료 등급 모델. 구글 쪽에서 모델명을 바꾸면 여기만 수정하면 됨
const MAX_ROWS = 60;
const MAX_QUESTION_LEN = 300;

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (!env.GEMINI_API_KEY) {
      return json({ error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. Cloudflare Pages 환경변수를 확인하세요." }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "요청 형식이 올바르지 않습니다." }, 400);
    }

    const question = String(body.question || "").slice(0, MAX_QUESTION_LEN).trim();
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
    const contextLabel = String(body.context || "").slice(0, 60);

    if (!question) return json({ error: "질문을 입력해주세요." }, 400);
    if (rows.length === 0) return json({ error: "분석할 데이터가 없습니다. 필터 조건을 확인해주세요." }, 400);

    const dataText = rows.map((r, i) => `${i + 1}. ${JSON.stringify(r)}`).join("\n");

    const prompt =
`당신은 캠핑용품/신발 브랜드의 재고관리 담당자를 돕는 어시스턴트입니다.
아래 [데이터]는 대시보드 화면에 현재 필터링되어 보이는 내용입니다(${contextLabel}, 총 ${rows.length}건 - 화면에 더 있어도 최대 ${MAX_ROWS}건까지만 전달됨).
반드시 이 데이터에 있는 내용만 근거로 답하세요. 데이터에서 확인할 수 없는 내용은 추측하지 말고
"주어진 데이터에서는 확인할 수 없습니다"라고 답하세요.
숫자를 언급할 때는 데이터에 있는 값을 그대로 인용하세요.
답변은 한국어로, 담당자가 바로 읽고 판단할 수 있도록 간결한 문장으로 작성하세요(불필요한 서론 없이 바로 핵심부터).

[데이터]
${dataText}

[질문]
${question}`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return json({ error: `AI 호출 실패 (${res.status}): ${errText.slice(0, 300)}` }, 502);
    }

    const data = await res.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || "응답을 받지 못했습니다.";
    return json({ answer });
  } catch (e) {
    return json({ error: "오류: " + e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
