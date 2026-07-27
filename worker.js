// ============================================================
// 바오지 대시보드 - 로그인 보호 Worker (2026-07-21)
// ============================================================
// [중요] 이 사이트는 원래 Cloudflare Pages로 배포했지만, Cloudflare가
// 최근 Pages를 "Workers + 정적 자산(Assets)" 방식으로 통합/이관하면서
// 실제 대시보드에서는 "Workers" 프로젝트로 보이는 상태로 바뀌어 있었습니다
// (라이브로 화면을 보면서 확인함 - baoji-dashboard.****.workers.dev 로
// 서빙되고 있고, "정적 자산만 있는 Worker"라 대시보드에서 바로 변수/바인딩을
// 추가할 수 없는 상태였음). 그래서 처음에 만들어드렸던
// functions/_middleware.js + functions/login.js + functions/logout.js
// (Cloudflare Pages Functions 방식)는 이 프로젝트 구조에는 맞지 않아
// 이 파일 하나로 합쳐서 다시 만들었습니다. 이 파일이 이제 "메인 Worker
// 스크립트" 역할을 하고, 정적 파일(index.html, data_admin.xlsx 등)은
// env.ASSETS 를 통해 이 스크립트가 필요할 때 직접 가져다 서빙합니다.
//
// 기존 functions/ 폴더는 이제 사용하지 않습니다(삭제해도 됨, 남겨둬도
// wrangler.jsonc에서 참조하지 않으면 무시됩니다).

import { pbkdf2Hash, createSession, verifySession, parseCookie } from './crypto.js';

const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30일

// [2026-07-21 변경] 세션 서명용 비밀키를 Cloudflare 대시보드의 "Variables and secrets"
// (env.SESSION_SECRET)가 아니라, KV(dashboard-users)의 특수 키 "__session_secret__"에서
// 읽어오도록 바꿨습니다.
// 이유: GitHub에 새 커밋을 push할 때마다 Cloudflare의 Git 연동 빌드(npx wrangler deploy)가
// 실행되는데, 이 과정에서 대시보드에 등록해둔 SESSION_SECRET이 알 수 없는 이유로 반복적으로
// 초기화(삭제)되는 현상이 실제로 두 번 확인됐습니다(로그인 계정은 멀쩡한데 로그인만 안 되는
// 증상으로 나타남). 반면 KV(dashboard-users)에 저장한 계정 정보는 코드를 아무리 재배포해도
// 한 번도 지워진 적이 없었으므로, 같은 KV 저장소에 비밀키도 같이 넣어서 이 문제를 근본적으로
// 피했습니다. 이제부터는 git push를 아무리 반복해도 로그인이 깨지지 않습니다.
const SESSION_SECRET_KV_KEY = '__session_secret__';

async function getSessionSecret(env) {
  const secret = await env.USERS.get(SESSION_SECRET_KV_KEY);
  if (!secret) {
    throw new Error('SESSION_SECRET_NOT_SET_IN_KV');
  }
  return secret;
}

// [2026-07-27 추가] 대시보드 내장 AI 질의응답 기능(/api/ask-ai)에 쓰는 Gemini API 키.
// 처음엔 Cloudflare Pages Functions(functions/api/ask-ai.js) 방식으로 만들었지만, 이
// 프로젝트는 실제로는 "정적 자산이 있는 Worker" 구조라 functions/ 폴더가 인식되지
// 않습니다(위 2026-07-21 주석 참고). 그래서 이 파일(worker.js) 안으로 합쳤습니다.
// 키 저장 위치도 SESSION_SECRET과 같은 이유로 Cloudflare "Variables and secrets"가
// 아니라 KV(dashboard-users)에 "__gemini_api_key__" 라는 이름으로 저장합니다 - git push
// 때마다 Variables/secrets 값이 알 수 없는 이유로 초기화되는 현상이 실제로 있었기
// 때문에, 이미 재배포에도 지워지지 않는 것이 확인된 KV를 그대로 재사용합니다.
const GEMINI_KEY_KV_KEY = '__gemini_api_key__';
// [2026-07-27 수정] gemini-2.0-flash는 2026-06-01부로 완전 종료(shutdown)된 모델이라
// 호출하면 429(quota exceeded)로 응답이 옴 - 실제로는 모델이 없어진 것. Google 공식
// deprecation 문서 기준 무료tier 권장 대체 모델인 gemini-3.5-flash로 교체함.
const GEMINI_MODEL = 'gemini-3.5-flash'; // 구글이 모델명을 또 바꾸면 여기만 수정
const AI_MAX_ROWS = 60;
const AI_MAX_QUESTION_LEN = 300;

async function getGeminiKey(env) {
  const key = await env.USERS.get(GEMINI_KEY_KV_KEY);
  if (!key) {
    throw new Error('GEMINI_KEY_NOT_SET_IN_KV');
  }
  return key;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 로그인 처리(POST)
    if (url.pathname === '/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // 로그아웃
    if (url.pathname === '/logout') {
      return handleLogout(url);
    }

    // 로그인 화면 자체는 인증 없이 통과(정적 파일 그대로 서빙)
    // [중요] /login.html 이라는 "확장자 있는" 경로로 그대로 ASSETS.fetch()를
    // 호출하면, Cloudflare 정적 자산의 기본 html_handling 규칙(auto-trailing-slash)
    // 때문에 "이 파일은 확장자 없이 불러야 하는 게 정식 경로"라며 307로
    // "/login"으로 리다이렉트해버립니다. 그런데 "/login"으로 다시 들어오면
    // 아래 세션 체크 로직에서 "로그인 안 됨 -> /login.html로 리다이렉트"가
    // 실행되어, /login.html <-> /login 사이를 영원히 왔다갔다하는 무한
    // 리다이렉트가 발생합니다(2026-07-21 실제로 이 문제 발생 확인).
    // 그래서 GET /login과 GET /login.html을 둘 다 여기서 받아서, 항상
    // "확장자 없는" /login 경로로 ASSETS에 요청해야 리다이렉트 없이 200으로
    // 바로 서빙됩니다.
    if ((url.pathname === '/login' || url.pathname === '/login.html') && request.method === 'GET') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/login';
      return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    }

    // 실제 데이터 파일 이름으로의 직접 접근은 항상 차단
    if (url.pathname === '/data_admin.xlsx' || url.pathname === '/data_general.xlsx') {
      return new Response('Not Found', { status: 404 });
    }

    // ---- 여기부터는 로그인 여부를 반드시 확인 ----
    let sessionSecret;
    try {
      sessionSecret = await getSessionSecret(env);
    } catch (e) {
      return new Response(
        '서버 설정 오류: 세션 비밀키가 아직 설정되지 않았습니다. Cloudflare 대시보드의 dashboard-users(KV)에 "__session_secret__" 키를 추가해주세요.',
        { status: 500 }
      );
    }

    const cookieHeader = request.headers.get('Cookie');
    const token = parseCookie(cookieHeader, 'session');
    const session = await verifySession(token, sessionSecret);

    if (!session) {
      return Response.redirect(url.origin + '/login', 302);
    }

    // data.xlsx 요청이면 권한에 맞는 실제 파일로 내부적으로 바꿔서 서빙
    if (url.pathname === '/data.xlsx') {
      const target = new URL(request.url);
      target.pathname = session.r === 'admin' ? '/data_admin.xlsx' : '/data_general.xlsx';
      return env.ASSETS.fetch(new Request(target.toString(), request));
    }

    // 대시보드 내장 AI 질의응답(로그인한 사용자만 호출 가능 - 무료 쿼터 보호)
    if (url.pathname === '/api/ask-ai' && request.method === 'POST') {
      return handleAskAI(request, env);
    }

    // 그 외 나머지(index.html 등)는 정적 자산 그대로 서빙
    return env.ASSETS.fetch(request);
  },
};

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('요청 형식이 올바르지 않습니다.', 400);
  }

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!username || !password) {
    return jsonError('아이디와 비밀번호를 입력하세요.', 400);
  }

  // "__session_secret__"는 세션 서명용 비밀키 저장 전용 키이므로, 혹시라도 같은 이름의
  // 아이디로 로그인을 시도하는 경우를 대비해 항상 차단합니다.
  if (username === SESSION_SECRET_KV_KEY) {
    return jsonError('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
  }

  let sessionSecret;
  try {
    sessionSecret = await getSessionSecret(env);
  } catch (e) {
    return jsonError(
      '서버 설정 오류: 세션 비밀키가 아직 설정되지 않았습니다. 관리자에게 문의하세요.',
      500
    );
  }

  const raw = await env.USERS.get(username);
  if (!raw) {
    return jsonError('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
  }

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    return jsonError('사용자 설정 오류입니다. 관리자에게 문의하세요.', 500);
  }

  const computed = await pbkdf2Hash(password, rec.salt);
  if (computed.hash !== rec.hash) {
    return jsonError('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const token = await createSession({ u: username, r: rec.role, exp }, sessionSecret);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append(
    'Set-Cookie',
    `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`
  );

  return new Response(JSON.stringify({ ok: true, role: rec.role }), { headers });
}

function handleLogout(url) {
  const headers = new Headers();
  headers.append('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  headers.append('Location', url.origin + '/login');
  return new Response(null, { status: 302, headers });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// [2026-07-27 추가] 대시보드 화면에 "현재 필터링된 데이터"만 넘겨서 그 안에서만
// 답하게 하는 AI 질의 프록시. 원래 functions/api/ask-ai.js (Pages Functions)로
// 만들었던 것을 이 Worker 구조에 맞게 그대로 옮긴 것 - 로직은 동일함.
async function handleAskAI(request, env) {
  let geminiKey;
  try {
    geminiKey = await getGeminiKey(env);
  } catch (e) {
    return aiJson(
      { error: '서버에 Gemini API 키가 설정되어 있지 않습니다. KV(dashboard-users)에 "__gemini_api_key__" 키를 추가해주세요.' },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return aiJson({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  const question = String(body.question || '').slice(0, AI_MAX_QUESTION_LEN).trim();
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, AI_MAX_ROWS) : [];
  const contextLabel = String(body.context || '').slice(0, 60);

  if (!question) return aiJson({ error: '질문을 입력해주세요.' }, 400);
  if (rows.length === 0) return aiJson({ error: '분석할 데이터가 없습니다. 필터 조건을 확인해주세요.' }, 400);

  const dataText = rows.map((r, i) => `${i + 1}. ${JSON.stringify(r)}`).join('\n');

  const prompt =
`당신은 캠핑용품/신발 브랜드의 재고관리 담당자를 돕는 어시스턴트입니다.
아래 [데이터]는 대시보드 화면에 현재 필터링되어 보이는 내용입니다(${contextLabel}, 총 ${rows.length}건 - 화면에 더 있어도 최대 ${AI_MAX_ROWS}건까지만 전달됨).
반드시 이 데이터에 있는 내용만 근거로 답하세요. 데이터에서 확인할 수 없는 내용은 추측하지 말고
"주어진 데이터에서는 확인할 수 없습니다"라고 답하세요.
숫자를 언급할 때는 데이터에 있는 값을 그대로 인용하세요.
답변은 한국어로, 담당자가 바로 읽고 판단할 수 있도록 간결한 문장으로 작성하세요(불필요한 서론 없이 바로 핵심부터).

[데이터]
${dataText}

[질문]
${question}`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
      }),
    });
  } catch (e) {
    return aiJson({ error: 'AI 서버 호출 중 네트워크 오류: ' + e.message }, 502);
  }

  if (!res.ok) {
    const errText = await res.text();
    return aiJson({ error: `AI 호출 실패 (${res.status}): ${errText.slice(0, 300)}` }, 502);
  }

  const data = await res.json();
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || '응답을 받지 못했습니다.';
  return aiJson({ answer });
}

function aiJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
