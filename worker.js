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

// [2026-07-27 추가] 대시보드 내장 AI 질의응답 기능(/api/gemini-key)에 쓰는 Gemini API 키.
// 처음엔 Cloudflare Pages Functions(functions/api/ask-ai.js) 방식으로 만들었지만, 이
// 프로젝트는 실제로는 "정적 자산이 있는 Worker" 구조라 functions/ 폴더가 인식되지
// 않습니다(위 2026-07-21 주석 참고). 그래서 이 파일(worker.js) 안으로 합쳤습니다.
// 키 저장 위치도 SESSION_SECRET과 같은 이유로 Cloudflare "Variables and secrets"가
// 아니라 KV(dashboard-users)에 "__gemini_api_key__" 라는 이름으로 저장합니다 - git push
// 때마다 Variables/secrets 값이 알 수 없는 이유로 초기화되는 현상이 실제로 있었기
// 때문에, 이미 재배포에도 지워지지 않는 것이 확인된 KV를 그대로 재사용합니다.
// [2026-07-27 추가 변경] 실제 Gemini 호출(모델명/프롬프트 구성/행 개수 제한 등)은 이제
// 이 파일이 아니라 브라우저(기간검색 변경 버전.html)에서 처리함 - 이 Worker는 로그인
// 확인 후 키 값만 건네주는 역할만 남음. 자세한 이유는 아래 /api/gemini-key 라우트 주석 참고.
const GEMINI_KEY_KV_KEY = '__gemini_api_key__';

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

    // [2026-07-27 변경] 대시보드 내장 AI 질의응답: 처음엔 이 Worker가 Gemini를 대신
    // 호출해주는 완전 프록시(/api/ask-ai, POST)로 만들었으나, Cloudflare Worker의
    // 발신 IP가 Gemini 무료 API의 "위치 미지원"(400 FAILED_PRECONDITION) 오류를
    // 계속 유발함(실제로 재현 확인 - 한국에서 쓰는 것과 무관, Cloudflare 인프라 자체
    // 문제). 그래서 브라우저(사용자의 실제 한국 IP)가 Gemini를 직접 호출하는 방식으로
    // 바꾸고, 이 Worker는 로그인 확인 후 키 값만 건네주는 역할만 함 - 그래서
    // 데이터/프롬프트를 만드는 로직은 기간검색 변경 버전.html(클라이언트) 쪽으로 옮겼음.
    // 키가 로그인한 브라우저의 페이지 소스/네트워크탭에 노출되긴 하지만, 이미 로그인
    // 게이트가 있고 무료 등급 키라 과금 위험이 없어서(초과 시 그냥 요청이 막힐 뿐) 이
    // 정도 노출은 감수하기로 함.
    if (url.pathname === '/api/gemini-key' && request.method === 'GET') {
      return handleGeminiKeyRequest(env);
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

// [2026-07-27 변경] 로그인 확인이 끝난 뒤에만 도달하는 라우트이므로, 여기서는
// KV에 저장된 Gemini 키를 그대로 꺼내서 돌려주기만 함 - 실제 Gemini 호출과 프롬프트
// 구성은 브라우저(기간검색 변경 버전.html의 askAI())에서 함(이유는 위 라우팅 주석 참고).
async function handleGeminiKeyRequest(env) {
  try {
    const key = await getGeminiKey(env);
    return aiJson({ key });
  } catch (e) {
    return aiJson(
      { error: '서버에 Gemini API 키가 설정되어 있지 않습니다. KV(dashboard-users)에 "__gemini_api_key__" 키를 추가해주세요.' },
      500
    );
  }
}

function aiJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
