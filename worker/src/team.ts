import { OAuthProvider, OAuthError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { serveMcp, type DirectEnv } from "./direct.ts";
import { publisherFetch } from "./release-publisher.ts";
import { readBody, validBearer } from "./http.ts";
import { sha256 } from "./r2-objects.ts";

export interface TeamEnv extends DirectEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GISUL_PUBLIC_URL: string;
  GISUL_GITHUB_ORG: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_AUTH_MODE?: "app" | "oauth";
  GISUL_CI_TOKEN?: string;
}
type Props = { userId: string; login: string; githubClientId: string; githubToken: string; githubRefresh?: string; githubExpires?: number; canWrite: boolean };
type LoginState = { request: AuthRequest; cookieHash: string; verifier: string; phase: "consent" | "github"; expires: number };
class AuthFailure extends Error { constructor(public status: number, message: string) { super(message); } }
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cookieName = (state: string) => `__Host-gisul-${state.slice(0, 12)}`;
const cookie = (state: string, value: string, maxAge: number) => `${cookieName(state)}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

function page(title: string, body: string, status = 200, headers: HeadersInit = {}, formAction = "'self'"): Response {
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Gisul</title><style>body{font:17px/1.6 system-ui,sans-serif;margin:64px auto;padding:0 24px;max-width:540px;color:#202329;background:#fafaf8}h1{font-size:28px}small{color:#555}button,a.button{font:inherit;display:inline-block;border:0;border-radius:8px;background:#175b48;color:white;padding:12px 20px;cursor:pointer;text-decoration:none}button.secondary{background:#e6e8e5;color:#202329;margin-left:8px}button:focus-visible,a:focus-visible{outline:3px solid #2461bb;outline-offset:4px}code{overflow-wrap:anywhere}</style><main><small>Gisul</small><h1>${escape(title)}</h1>${body}</main></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`, "referrer-policy": "strict-origin", "x-content-type-options": "nosniff", ...headers } });
}

async function github(path: string, token: string): Promise<Record<string, any>> {
  let response: Response;
  try { response = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "gisul", "x-github-api-version": "2022-11-28" }, redirect: "manual", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new AuthFailure(503, "GitHub 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요."); }
  if (response.status === 401) throw new AuthFailure(401, "GitHub 연결이 만료되거나 해제되었습니다. Codex에서 Gisul에 다시 로그인해 주세요.");
  if (response.status === 404) throw new AuthFailure(403, "조직 소속을 확인할 수 없습니다. 조직 초대를 수락했는지, GitHub에서 Gisul의 조직 접근을 허용했는지 확인해 주세요.");
  if (response.status === 403) throw new AuthFailure(503, "GitHub에서 조직 확인을 허용하지 않았습니다. 조직의 앱 접근 정책 또는 API 사용 한도를 확인해 주세요.");
  if (!response.ok) throw new AuthFailure(503, "GitHub 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  return response.json();
}

async function oauthToken(env: TeamEnv, values: Record<string, string>): Promise<Record<string, any>> {
  let response: Response;
  try { response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...values }), redirect: "manual", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new AuthFailure(503, "로그인 결과를 확인할 수 없습니다. Codex에서 연결을 다시 시작해 주세요."); }
  if (!response.ok) throw new AuthFailure(503, "GitHub 로그인 서비스에 연결할 수 없습니다.");
  const result = await response.json<Record<string, any>>();
  if (typeof result.access_token !== "string" || result.error) throw new AuthFailure(401, "로그인 요청이 만료되었거나 취소되었습니다. Codex에서 연결을 다시 시작해 주세요.");
  return result;
}

export async function member(env: TeamEnv, token: string, expectedId?: string): Promise<{ userId: string; login: string }> {
  const membership = await github(`/user/memberships/orgs/${encodeURIComponent(env.GISUL_GITHUB_ORG)}`, token);
  if (membership.state !== "active" || String(membership.organization?.login).toLowerCase() !== env.GISUL_GITHUB_ORG.toLowerCase()) throw new AuthFailure(403, "설정된 GitHub 조직에 가입된 계정으로 연결해 주세요.");
  const userId = String(membership.user?.id ?? "");
  const login = membership.user?.login;
  if (!/^\d+$/.test(userId) || typeof login !== "string" || (expectedId && expectedId !== userId)) throw new AuthFailure(401, "연결된 계정을 확인할 수 없습니다. 다시 로그인해 주세요.");
  return { userId, login };
}

function currentGrant(props: Props, env: TeamEnv): void {
  if (props.githubClientId !== env.GITHUB_CLIENT_ID) throw new AuthFailure(401, "Gisul 연결 방식이 업데이트되었습니다. Codex에서 GitHub 계정을 한 번 다시 연결해 주세요.");
}

async function loginState(request: Request, env: TeamEnv, state: string): Promise<LoginState> {
  if (!/^[a-f0-9]{64}$/.test(state)) throw new AuthFailure(400, "유효하지 않은 연결 요청입니다. Codex에서 연결을 다시 시작해 주세요.");
  const value = request.headers.get("cookie")?.split(";").map(c => c.trim()).find(c => c.startsWith(`${cookieName(state)}=`))?.slice(cookieName(state).length + 1);
  const saved = await env.OAUTH_KV.get<LoginState>(`gisul:login:${state}`, "json");
  if (!value || !saved || saved.expires < Date.now() || await sha256(value) !== saved.cookieHash) throw new AuthFailure(400, "연결 요청이 만료되었거나 다른 브라우저에서 열렸습니다. Codex에서 연결을 다시 시작해 주세요.");
  return saved;
}

export const authHandler: ExportedHandler<TeamEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/")) return publisherFetch(request, env);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "gisul-team", storage: "r2", authentication: "github-oauth", server_version: env.GISUL_SERVER_VERSION ?? "unknown" }, { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/") return page("팀 스킬을 Codex에서 사용하세요", "<p>Gisul 플러그인을 설치하고 Codex에서 계정을 연결하세요. GitHub 조직 계정으로 로그인하면 팀 스킬을 검색하고 사용할 수 있습니다.</p><p>이미 연결했다면 Codex에서 <strong>Gisul에서 이 작업에 맞는 스킬을 찾아줘</strong>라고 요청해 보세요.</p>");
    if (!["/authorize", "/callback"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return page("아직 연결 준비 중입니다", "<p>조직 관리자가 GitHub 로그인 설정을 완료해야 합니다. 설치한 플러그인은 유지하고 설정 완료 후 연결해 주세요.</p>", 503);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        if (!oauth.codeChallenge || oauth.codeChallengeMethod !== "S256") throw new AuthFailure(400, "이 클라이언트는 안전한 로그인을 지원하지 않습니다. 최신 Codex로 업데이트해 주세요.");
        if (oauth.scope.some(scope => !["skills:read", "skills:write"].includes(scope))) throw new AuthFailure(400, "지원하지 않는 접근 권한입니다.");
        const client = await env.OAUTH_PROVIDER.lookupClient(oauth.clientId);
        if (!client) throw new AuthFailure(400, "클라이언트를 확인할 수 없습니다.");
        const state = random(), binding = random();
        await env.OAUTH_KV.put(`gisul:login:${state}`, JSON.stringify({ request: oauth, cookieHash: await sha256(binding), verifier: random(), phase: "consent", expires: Date.now() + 600_000 } satisfies LoginState), { expirationTtl: 600 });
        return page("Codex에 팀 스킬 연결", `<p><strong>${escape(client.clientName ?? "MCP 클라이언트")}</strong>가 팀 스킬에 접근하려고 합니다.</p><p>연결 대상: <code>${escape(new URL(oauth.redirectUri).origin)}</code></p><p>허용할 작업: 스킬 검색·읽기${oauth.scope.includes("skills:write") ? ", 편집 권한이 있는 계정의 스킬 생성·수정" : ""}.</p><p><strong>${escape(env.GISUL_GITHUB_ORG)}</strong> GitHub 조직 계정으로 로그인하세요. 별도 회원가입은 필요하지 않습니다.</p><form method="post" action="/authorize"><input type="hidden" name="state" value="${state}"><button name="action" value="allow">GitHub로 연결하기</button><button class="secondary" name="action" value="deny">취소</button></form>`, 200, { "set-cookie": cookie(state, binding, 600) }, `'self' https://github.com ${new URL(oauth.redirectUri).origin}`);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        if (request.headers.get("origin") !== url.origin) throw new AuthFailure(403, "연결 화면에서 다시 시도해 주세요.");
        const body = new URLSearchParams(new TextDecoder().decode(await readBody(request, 4096)));
        const state = body.get("state") ?? "";
        const saved = await loginState(request, env, state);
        if (saved.phase !== "consent") throw new AuthFailure(400, "이미 진행 중인 연결입니다. GitHub 로그인 화면에서 계속해 주세요.");
        if (body.get("action") !== "allow") {
          await env.OAUTH_KV.delete(`gisul:login:${state}`);
          const redirect = new URL(saved.request.redirectUri);
          redirect.searchParams.set("error", "access_denied");
          if (saved.request.state) redirect.searchParams.set("state", saved.request.state);
          return new Response(null, { status: 302, headers: { location: redirect.href, "set-cookie": cookie(state, "", 0), "cache-control": "no-store" } });
        }
        saved.phase = "github";
        await env.OAUTH_KV.put(`gisul:login:${state}`, JSON.stringify(saved), { expirationTtl: Math.max(60, Math.ceil((saved.expires - Date.now()) / 1000)) });
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(saved.verifier));
        const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.GISUL_PUBLIC_URL}/callback`, state, code_challenge: challenge, code_challenge_method: "S256", allow_signup: "false" }).toString();
        if (env.GITHUB_AUTH_MODE === "oauth") authorize.searchParams.set("scope", saved.request.scope.includes("skills:write") ? "read:org repo" : "read:org");
        return new Response(null, { status: 302, headers: { location: authorize.href, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const saved = await loginState(request, env, state);
        if (saved.phase !== "github") throw new AuthFailure(400, "먼저 연결 화면에서 GitHub 로그인을 시작해 주세요.");
        await env.OAUTH_KV.delete(`gisul:login:${state}`);
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || !code || code.length > 2048) throw new AuthFailure(400, "로그인이 취소되었습니다. Codex에서 연결을 다시 시작할 수 있습니다.");
        const token = await oauthToken(env, { code, redirect_uri: `${env.GISUL_PUBLIC_URL}/callback`, code_verifier: saved.verifier });
        const user = await member(env, token.access_token);
        const requested = saved.request.scope.length ? saved.request.scope : ["skills:read"];
        // Persist the approved operations. GitHub enforces this user's repository
        // access on actual writes; there is no separate Gisul editor registry.
        const scope = requested.filter(s => s === "skills:read" || s === "skills:write");
        if (!scope.includes("skills:read")) scope.push("skills:read");
        const props: Props = { ...user, githubClientId: env.GITHUB_CLIENT_ID, githubToken: token.access_token, githubRefresh: token.refresh_token, githubExpires: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined, canWrite: scope.includes("skills:write") };
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: saved.request, userId: user.userId, metadata: { login: user.login, organization: env.GISUL_GITHUB_ORG }, scope, props });
        return new Response(null, { status: 302, headers: { location: redirectTo, "cache-control": "no-store", "set-cookie": cookie(state, "", 0), "referrer-policy": "no-referrer" } });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      return page("연결을 완료하지 못했습니다", `<p role="alert">${escape(error instanceof AuthFailure ? error.message : "연결 요청을 확인할 수 없습니다. Codex에서 로그인을 다시 시작해 주세요.")}</p>`, error instanceof AuthFailure ? error.status : 400);
    }
  },
};

export default {
  async fetch(request: Request, env: TeamEnv, ctx: ExecutionContext): Promise<Response> {
    let base: URL;
    try { base = new URL(env.GISUL_PUBLIC_URL); } catch { return new Response("Gisul URL is not configured", { status: 503 }); }
    if (base.protocol !== "https:" || base.origin !== env.GISUL_PUBLIC_URL || !/^[a-zA-Z0-9-]+$/.test(env.GISUL_GITHUB_ORG ?? "")) return new Response("Gisul configuration is invalid", { status: 503 });
    if (new URL(request.url).origin !== base.origin) return new Response("Use the canonical Gisul endpoint", { status: 421 });
    // A separate, read-only CI identity verifies staged releases; never distributed to users.
    if (new URL(request.url).pathname === "/mcp" && await validBearer(request, env.GISUL_CI_TOKEN ?? "")) return serveMcp(request, { ...env, GISUL_NATIVE_TOOLS: "true" }, { canWrite: false });
    // Publication remains separately authenticated. Personal static MCP credentials are never accepted by this entrypoint.
    if (new URL(request.url).pathname.startsWith("/admin/") && !await validBearer(request, env.GISUL_PUBLISH_TOKEN ?? "")) return new Response("Unauthorized", { status: 401 });
    const provider = new OAuthProvider<TeamEnv>({
      apiRoute: "/mcp",
      apiHandler: { async fetch(req, bindings, context) {
        if (new URL(req.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
        const props = context.props as Props;
        try {
          currentGrant(props, bindings);
          await member(bindings, props.githubToken, props.userId);
          return serveMcp(req, { ...bindings, GISUL_NATIVE_TOOLS: "true", GISUL_GITHUB_TOKEN: props.githubToken }, { canWrite: props.canWrite });
        } catch (error) {
          const status = error instanceof AuthFailure ? error.status : 503;
          return Response.json({ error: status === 401 ? "invalid_token" : status === 403 ? "access_denied" : "temporarily_unavailable", message: error instanceof AuthFailure ? error.message : "조직 접근을 확인할 수 없습니다." }, { status, headers: { "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base.origin}/.well-known/oauth-protected-resource/mcp"` } : {}) } });
        }
      } },
      defaultHandler: authHandler,
      authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["skills:read", "skills:write"], accessTokenTTL: 900, refreshTokenTTL: 30 * 86400,
      allowPlainPKCE: false, allowImplicitFlow: false,
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${base.origin}/mcp`, authorization_servers: [base.origin], scopes_supported: ["skills:read", "skills:write"], resource_name: "Gisul" },
      async tokenExchangeCallback(options) {
        let props = options.props as Props;
        try {
          currentGrant(props, env);
          if (props.githubExpires && props.githubExpires < Date.now() + 60_000) {
            if (!props.githubRefresh) throw new AuthFailure(401, "GitHub login expired");
            const token = await oauthToken(env, { grant_type: "refresh_token", refresh_token: props.githubRefresh });
            props = { ...props, githubToken: token.access_token, githubRefresh: token.refresh_token, githubExpires: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined };
          }
          const user = await member(env, props.githubToken, props.userId);
          return { newProps: { ...props, ...user }, accessTokenProps: { ...props, ...user, canWrite: props.canWrite && options.requestedScope.includes("skills:write") } };
        } catch (error) { throw new OAuthError(error instanceof AuthFailure && error.status === 503 ? "temporarily_unavailable" : "invalid_grant", { description: "GitHub organization access could not be verified. Retry or sign in again." }); }
      },
    });
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<TeamEnv>;
