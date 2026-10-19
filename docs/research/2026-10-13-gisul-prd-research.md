# gisul PRD 리서치

로컬 스킬 라우터와 사용 대시보드

작성일 2026-10-13 · 조사 세션 `.omo/ulw-research/20261013-100055` · 대상: 1인 다중 에이전트용 로컬 스킬 라우터

## 요약

결론부터 말하면 gisul은 각 런타임의 기본 스킬 탐색을 **대체하지 말고 보완**해야 합니다. 보완의 축은 두 가지입니다. 하나는 여러 에이전트에서 실제로 무슨 일이 있었는지 보여주는 관찰자, 다른 하나는 작업 문장으로 스킬을 고르는 검색 도구입니다. Claude Code, Codex, Gemini CLI, Cursor는 모두 스킬 설명을 모델 컨텍스트에 넣고 모델이 스스로 고르게 합니다 [S21][S64]. 이걸 대체하면 기본 로더에 묶인 기능을 잃고, 성능도 기껏해야 같아집니다 [S41][S15]. 대신 빈자리는 뚜렷합니다. 조사한 스킬 서버 중 세션 트레이스, 흐름도, 시간대 히트맵을 제공하는 곳은 없었습니다 [S1][S2][S5][S6]. 사용자 쪽에서도 "어떤 스킬이 실제로 쓰였는지 모른다"는 요청이 반복해서 나옵니다 [S11][S12].

MVP(세션 트레이스, 흐름도, 히트맵)는 유지하되, 리서치에서 바꿔야 할 점이 세 가지 나왔습니다.

1. **세션 식별을 MCP에 기대면 안 됩니다.** 현재 MCP 스펙(2026-07-28)은 `Mcp-Session-Id`를 없앴고, 어떤 버전에도 대화 ID는 없습니다 [S27][S28]. 세션과 사용자 작업 문장은 런타임별 훅이나 OpenTelemetry 내보내기로 받아야 합니다 [S16][S17][S18][S20].
2. **흐름도의 "결과" 열은 성공 여부가 아니라 관찰 가능한 채택 상태여야 합니다.** 결과로 쓸 수 있는 상태는 로드됨, 노출만 됨, 맞는 스킬 없음, 중단됨입니다. 1인 사용량은 적고(이 기기에서 주당 약 40회 활성화), 성공 여부는 어느 런타임도 알려주지 않습니다. 데이터가 적을 때는 표를 기본 화면으로 둡니다 [S35][S36].
3. **검색 품질은 지금 구조로는 부족합니다.** 현재 gisul 랭커에 키워드가 겹치지 않는 실제 말투의 한국어·영어 요청 8개를 넣었더니 8개 모두 결과가 비었습니다 [V3]. 별칭(aliases_ko) 필드, 예시 요청, trigram 토크나이저, 에이전트 쪽 질의 재작성이 필요합니다. 임베딩은 실제 프롬프트로 만든 평가셋에서 이득이 확인될 때만 도입합니다 [S42][S45][S47].

## 문제와 근거

사용자가 겪는 문제를 GitHub 이슈, HN 스레드, 블로그에서 모아 빈도순으로 정리했습니다(독립 보고 수, 하한값).

| 순위 | 문제 | 보고 수 | 대표 근거 |
|---|---|---|---|
| 1 | 에이전트마다 스킬 경로가 달라 복사본이 생기고 서로 어긋남 | 약 14 | Claude Code 이슈, 반응 551개 [S9] |
| 2 | 스킬이 호출되지 않거나 무시됨 | 약 12 | Claude Code 이슈 다수 [S10] |
| 3 | 스킬이 많아지면 설명이 경고 없이 잘림 | 약 9 | 160개 실험에서 설명이 잘린 3개는 0번, 남은 7개는 7번 호출 [S15] |
| 4 | 새 컴퓨터로 옮기기 어려움 | 약 8 | 동기화 기능 요청이 not planned로 닫힘 [S13][S14] |
| 5 | 어떤 스킬이 쓰였는지 알 수 없음 | 약 6 | 로컬 skill-usage 로그 요청 [S11][S12] |

이 기기의 실측도 같은 방향을 가리킵니다(MEASURED, 최근 56일 집계 수치만) [V5]. 스킬 폴더 4곳의 스킬 수가 50, 40, 19, 11로 서로 달랐습니다. 활성화는 8주 동안 약 340회였고, 설치된 스킬의 약 절반은 한 번도 쓰이지 않았습니다. 이 수치는 skeptic 멤버가 정규식으로 센 근사치이며, 사용자가 직접 호출한 /skill은 빠져 있습니다.

규모가 작아도 선택 품질은 이미 떨어집니다. 모든 설명을 컨텍스트에 넣은 실험에서 정답 스킬만 있을 때보다 통과율이 스킬 52개에서 0.08, 102개에서 0.14, 202개에서 0.21 낮아졌습니다. 통계적으로 유의한 원인은 엉뚱한 스킬을 고르는 것이었습니다 [S44]. gisul이 대상으로 하는 10~200개 구간이 바로 이 구간입니다.

## 사용자와 핵심 시나리오

- **사용자**: Codex, Claude Code, OmO, Gajae Code, OpenClaw 같은 에이전트 여러 개를 쓰는 1인 개발자. 에이전트별 권한이나 신원 관리는 필요 없습니다.
- **시나리오 A (관찰)**: 일주일 작업 뒤 대시보드를 엽니다 [S11]. 어떤 작업에 어떤 스킬이 쓰였는지, 어떤 스킬이 한 번도 안 쓰였는지, 어떤 요청에서 맞는 스킬을 못 찾았는지 봅니다.
- **시나리오 B (추적)**: 특정 세션을 열어 요청 문장, 검색 후보와 점수, 로드한 스킬 버전, 읽은 참고 파일을 시간순으로 봅니다.
- **시나리오 C (개선)**: "맞는 스킬 없음"으로 끝난 요청을 평가 케이스로 저장하고, 스킬 설명을 고친 뒤 순위가 바뀌는지 확인합니다.
- **시나리오 D (이사)**: 새 컴퓨터에서 설치하고, 파일 하나나 Git 레포에서 가져온 뒤, 에이전트를 자동 감지해 연결합니다 [S13].

## 경쟁 지형과 빈자리

| 유형 | 예 | 하는 일 | 빠진 것 |
|---|---|---|---|
| MCP 스킬 서버 | skillport, K-Dense, skill-retrieval-mcp, StacklokLabs | 목록·검색·로드 | 사용 기록, UI |
| 텔레메트리가 있는 서버 | ai-rulez | 로컬 JSONL 이벤트(로드, 사용, 중단), OTLP 내보내기 | GUI 없음 [S1] |
| 로컬 대시보드가 있는 서버 | mcp-skill-hub | 라우터 통계(티어, 지연, 신뢰도) 화면 | 흐름·세션 트레이스 없음 [S2] |
| 피드백 점수 | skill-curator-mcp | 결과를 EMA 점수로 반영 | 에이전트가 직접 호출해야 함, UI 없음 [S3] |
| 데스크톱·CLI 매니저 | Skills Manager, skillshare, dotagents, npx skills | 설치, 동기화, 백업 | 사용 현황 없음 [S5][S6][S7][S8] |
| 관측 SaaS | Dash0, LangSmith Trajectories | 조직 단위 분석, 코딩 에이전트 세션 수집 | 로컬 우선 아님 [S32] |

표준 쪽 상황도 확인했습니다. MCP Skills Extension(SEP-2640)은 Final이지만, 공식 클라이언트 표에서 스킬을 완전히 지원하는 곳은 mcpc 하나입니다. Claude, Cursor, VS Code는 빈칸이고, 공식 SDK 구현도 진행 중입니다 [S29][S30]. 따라서 MVP는 지금처럼 MCP 도구(`search_skills` 등)로 제공하고, `skill://` 리소스 방식은 나중의 선택 사항으로 둡니다.

설치와 동기화는 이미 흔한 기능입니다 [S8][S5][S7]. gisul은 다섯 번째 스킬 저장소가 되지 말고, 기존 스킬 폴더를 **있는 자리에서 색인**해야 합니다.

## 요구사항: 계측과 세션 식별

**MCP만으로 알 수 있는 것은 클라이언트 이름뿐입니다.** 2025-11-25 스펙의 `Mcp-Session-Id`는 전송 세션일 뿐 대화 ID가 아니며, 2026-07-28 스펙에서 없어졌습니다 [S27][S28]. 실행 검증에서도 현재 SDK 1.30.0에서는 세션 ID와 clientInfo가 도구 핸들러까지 전달됐지만 [V2], 이는 이전 스펙 기준 동작입니다.

런타임별로 얻을 수 있는 정보는 다음과 같습니다.

| 런타임 | 작업 문장 | 세션 ID | 권장 수집 경로 |
|---|---|---|---|
| Claude Code | UserPromptSubmit 훅, OTel(옵트인) | 모든 훅과 OTel 이벤트 | OTel 우선, http 훅은 짧은 타임아웃 [S16][S17] |
| Codex | UserPromptSubmit 훅, OTel(옵트인) | 훅, OTel, MCP 호출의 _meta | OTel 우선. codex.skill_invocation으로 내장 스킬 감지 [S18][S19][S20] |
| Gemini CLI | BeforeAgent 훅 | session_id | command 훅 + 확장 묶음. activate_skill로 내장 스킬 감지 [S22] |
| Cursor | beforeSubmitPrompt 훅 | conversation_id | command 훅 [S23] |
| OpenCode, OmO | chat.message 플러그인 | sessionID | 플러그인 [S24] |
| OpenClaw | before_agent_run(대화 접근 허용 필요) | sessionKey | 플러그인, 부분 지원 [S25] |
| Gajae Code | loose 확장의 before_agent_start | sessionManager | loose 확장. 번들은 localhost MCP 불가 [S26] |

요구사항:
- **두 채널 수집**: gisul MCP 서버는 자기 도구 호출을 clientInfo와 벤더 `_meta`(있으면)와 함께 기록합니다. 런타임별 수집 팩(OTel 설정 또는 훅)은 작업 문장, 세션 ID, 내장 스킬 사용을 로컬 라우터로 보냅니다.
- **추적 핸들**: `search_skills`가 핸들을 돌려주고 `load_skill`이 그 핸들을 받게 합니다. 2026-07-28 스펙이 권하는 방식이며 [S27], 훅이 없는 클라이언트에서도 검색과 로드를 잇습니다.
- **연결 실패는 숨기지 않음**: 세션을 확정할 수 없는 호출은 "미귀속"으로 따로 표시합니다. 런타임별 귀속률 목표를 둡니다(ASSUMED 제안값: Claude, Codex, Gemini 95% 이상, 나머지는 최선).
- **훅은 에이전트를 막지 않음**: Claude Code의 훅 기본 타임아웃은 600초라서, 라우터가 멈추면 모든 프롬프트가 멈춥니다. 2~5초로 제한하고, 가능하면 비동기로 보냅니다 [S16].
- **내장 스킬 사용도 잡기**: Claude Code는 Skill 도구와 사용자 /skill 확장, Codex는 skill_invocation 이벤트, Gemini는 activate_skill로 잡습니다. 이 기기에서는 SKILL.md를 Read나 Bash로 직접 읽은 경우가 Skill 도구 호출보다 10배 이상(MEASURED) 많았으므로 [V5], 파일 읽기 규칙도 함께 둡니다.

**이벤트 스키마**는 OpenTelemetry GenAI 규약을 따릅니다. 이 규약에는 스킬 로드와 스킬 리소스 읽기 span이 이미 정의돼 있지만(Development 단계), 스킬 버전과 스킬 검색은 없습니다 [S31].
- `search_skills`는 retrieval span으로 기록합니다. 후보 목록은 `{id, score, rank}`입니다.
- `load_skill`과 `read_skill_file`은 execute_tool 세분화 span으로 기록합니다.
- 버전, digest, load_id, 어느 검색에서 온 로드인지, 채택 상태는 `gisul.*` 필드로 둡니다.
- 대화 ID는 런타임이 줄 때만 기록하고, 직접 만들어내지 않습니다 [S31].
- 저장은 JSONL 원장 + SQLite 색인으로 하고, OTLP 내보내기를 선택으로 둡니다.

지금 gisul 이벤트 로그에는 후보 목록과 점수, 세션 ID, 결과가 없어서 이 화면을 만들 수 없습니다(`server/src/codex.ts` 이벤트 필드 확인).

## 요구사항: 세션 트레이스 화면

LLM 관측 도구는 모두 같은 3단 구조로 수렴했습니다. 세션(스레드), 트레이스(턴), span이고, 한 트레이스를 트리, 타임라인, 대화 같은 여러 방식으로 보여줍니다. 2025~26년에 새로 나온 화면은 모두 "에이전트가 무엇을 했는지"를 읽기 쉬운 이야기형으로 보여주는 쪽입니다 [S32][S33].

- **세션 목록**: 에이전트, 첫 작업 문장, 사용한 스킬, 채택 상태, 소요 시간, "맞는 스킬 없음" 표시. 실시간 갱신과 URL에 저장되는 필터를 둡니다.
- **세션 상세 기본 화면**: 세로 단계 목록입니다. 작업 요청, 검색(질의, 소요 시간, 후보와 점수, 선택 여부), 로드(고정된 버전), 참고 파일 읽기, 종료 순입니다.
- **보조 탭**: 트리, 타임라인. 그래프 뷰는 빼는데, 다른 도구에서 반복적인 버그 원인이었기 때문입니다.
- **빈 상태**: 이벤트가 아직 없으면 런타임별 연결 상태와 로그 경로를 보여줍니다. 검색이 없는 세션은 "gisul을 쓰지 않음", 후보가 없으면 "맞는 스킬 없음, 스킬 만들기"로 표시합니다.
- **용량**: 스킬 본문은 저장하지 않고 digest와 크기만 둡니다. 큰 페이로드는 트레이스 UI를 느리게 만드는 주된 원인이었습니다 [S34].

## 요구사항: 흐름도와 히트맵

**흐름도.** 분석 제품들은 고정된 노드 수 대신 단계별 상위 N개와 펼칠 수 있는 "기타" 노드로 복잡도를 제한합니다. Mixpanel은 단계마다 상위 3개, GA4는 상위 5개(최대 20)를 보여주고, PostHog는 상위 50개 전이에 최소 인원 필터를 씁니다 [S35][S36][S37]. 통제 실험에서는 Sankey가 원형 코드 다이어그램보다 빠르고 정확했습니다 [S38].

- 열: 작업 유형, 스킬, 채택 상태(로드됨, 노출만 됨, 맞는 스킬 없음, 중단됨). 성공 여부는 어느 런타임도 제공하지 않으므로, 결과 열에는 관찰 가능한 상태만 둡니다. 성공 여부는 사용자 평가가 있을 때만 별도 표시합니다.
- 단위: 세션. 한 세션에 여러 스킬이 있으면 기본은 "처음 로드한 스킬"로 세고, 전체 로드 수로 바꾸는 토글을 둡니다. 차트에 단위를 적습니다.
- 열마다 상위 6~8개 + 기타(n), 최소 링크 수 2 (ASSUMED, 제품 사례 기반) [S35][S36]. 링크 색은 채택 상태로 칠하고, 마우스를 올리면 연결된 경로를 강조합니다.
- 노드나 링크를 누르면 아래 세션 목록이 걸러집니다.
- 데이터가 적을 때(약 30세션 미만, 설계 판단이며 근거 수치 없음)는 상위 경로 표를 기본으로 보여줍니다.
- 작업 유형 분류는 MVP에서 스킬 태그와 규칙으로 하고, LLM 분류는 다음 단계로 둡니다.

**히트맵.**
- 요일×시간 7×24 칸입니다. 한 주의 시작 요일은 로캘에 따르고 [S40], 시각은 현지 시간으로 표시합니다.
- 기본 값은 시작된 세션 수이고, 5단계 단색 농도로 표시합니다.
- 행과 열 합계를 함께 둡니다. 데이터가 적으면 2시간이나 4시간 단위로 묶습니다(ASSUMED).
- 칸을 누르면 세션 목록이 걸러집니다.
- 연속 사용일(streak), 배지, "최고의 날" 같은 표현은 넣지 않습니다. 연속 기록 보상이 사용자에게 해롭다는 지적이 있고 [S39], 사용자도 축하 연출을 원하지 않았습니다.
- 보조로 스킬×주 히트맵을 둡니다. 사용량이 적어도 의미가 있는 형태입니다.

**구현.** d3-sankey 레이아웃에 SVG를 직접 그리는 방식을 권합니다(gzip 약 3~5kB) [S63]. CSS 변수로 다크 모드를 그대로 쓸 수 있습니다. ECharts는 대안입니다.

## 요구사항: 검색 품질

**현재 상태 실측.** 현재 랭커는 키워드가 하나도 겹치지 않으면 결과를 비웁니다. 대조 질의는 맞혔지만, 실제 말투로 쓴 8개 요청("DB 조회가 너무 느려서 원인 좀 봐줘" 등)은 8개 모두 빈 결과였습니다 [V3]. 샘플이 작아서 비율로 읽으면 안 되고, 실패 유형을 보여주는 근거로만 써야 합니다. 대규모 연구에서도 사용자 말투로 바꾼 질의에서는 BM25 nDCG@10이 0.088까지 떨어졌습니다 [S42].

**실제 에이전트 질의 로그(MEASURED).** "한국어로 말해도 에이전트는 영어로 검색한다"는 가정을 기존 Codex 이벤트 로그(`~/.codex/logs/gisul/events-*.jsonl`, 2026-09-18~25)로 확인했습니다 [V6].

| 구분 | 건수 |
|---|---|
| search 이벤트 전체 | 220 |
| 질의 없이 목록만 요청 | 134 |
| 스킬 이름 조회(예: aside-browser) | 80 |
| 작업 설명으로 검색 | 6 |
| 그중 한국어 | 4 |
| 그중 결과 0건 | 6 |

이 로그에서 에이전트는 작업 설명으로 거의 검색하지 않았고(MEASURED: 220건 중 6건) [V6], 검색할 때는 오히려 한국어가 더 많았습니다("Slack 메시지 QA 해석", "인터뷰" 등). 영어로 검색한 2건("browser account" 등)도 결과가 0건이었습니다. 표본이 작고 Codex 한 런타임, 이전 원격 버전 기준이라 비율로 일반화하면 안 됩니다. 그래도 두 가지는 분명합니다. 첫째, 에이전트가 알아서 영어로 바꿔 준다고 가정할 수 없습니다. 둘째, 영어로 바꿔도 단어가 안 겹치면 실패하므로 문제의 본질은 언어보다 어휘 불일치입니다. 따라서 도구 설명에 "스킬 어휘를 쓴 영어 의도 문장으로 검색하라"는 지침을 넣는 것이 가장 싼 1차 대책이고, aliases_ko와 예시 요청은 안전장치로 유지합니다. 훅 경로는 사용자의 한국어 원문을 그대로 받으므로 여기에는 처음부터 한국어 대응이 필요합니다.

**연구가 말하는 것과 말하지 않는 것.**
- 큰 공개 스킬 풀(수천~수만 개, 설명이 비슷한 스킬이 많음)에서는 본문 색인과 학습된 임베딩이 크게 이깁니다 [S41][S43]. 다만 이 이득은 해당 분포에 맞춰 학습한 결과입니다.
- 스킬이 적을 때는 방식 간 차이가 작습니다 [S47]. 범용 리랭커는 오히려 점수를 낮췄습니다 [S42].
- 합성 질의로 학습하면 실제 질의 성능이 떨어집니다(재현율 0.85에서 0.65) [S45]. 길고 명시적인 질의로 학습한 모델은 짧고 모호한 요청에 약합니다 [S46].
- 한국어 스킬 검색 벤치마크는 없습니다. 한국어 특화 모델 KURE-v1은 bge-m3보다 1점 미만 높았을 뿐입니다 [S48].

**요구사항.**
- **색인 필드**: 이름, 설명, when_to_use, 예시 요청, **aliases_ko**(한국어 별칭, 스킬 등록 때 한 번 생성), 본문 첫 문단. 검색 결과에는 frontmatter만 돌려줘서, 본문이 검색 결과로 새어 나가지 않게 합니다.
- **토크나이저**: SQLite FTS5 trigram을 씁니다. 한국어 조사 문제("커밋해줘"와 "커밋")를 해결하며, Node 24.18과 Bun 1.4.2에서 동작을 확인했습니다(MEASURED) [V5].
- **질의 쪽**: `search_skills` 설명에 "의도 중심으로 질의를 바꿔 넣으라"고 적습니다. 호출하는 쪽이 LLM이라 추가 비용이 없습니다. 훅 경로에서는 cwd와 최근 파일 같은 맥락도 함께 보냅니다.
- **형제 스킬**: re0, re0-loop, re0-work처럼 이름이 비슷한 스킬 묶음이 실제로 있습니다. 묶음과 단계 정보를 메타데이터로 두고, 평가 때 정확 재현율과 묶음 재현율을 따로 봅니다.
- **응답하지 않기(abstention)**: 검증된 기본 임계값은 없습니다. 실사용 예로는 코사인 0.30, 0.5가 있습니다 [S41][S3]. 평가셋의 "해당 없음" 케이스로 라이브러리마다 보정하고, 빈 결과에는 이유를 붙이고, 대시보드에 응답하지 않은 비율을 보여줍니다.
- **임베딩 도입 기준**: 실제 프롬프트 60~100개(절반 이상 한국어)로 평가셋을 만듭니다. BM25F+trigram+aliases_ko 대비 recall@3이 5점 이상 오를 때만 다국어 임베딩(Qwen3-Embedding-0.6B 우선 [S49], bge-m3 대안)을 넣습니다. 평가셋을 스킬 설명에서 합성하면 색인 내용을 그대로 확인하는 꼴이 되므로 금지합니다.
- **리랭커**: MVP에서는 쓰지 않습니다. 후보 20개를 리랭크하는 데 고성능 GPU에서도 831ms가 걸렸습니다 [S41].
- **회귀 방지**: 기존 `server/bench` 게이트를 유지하되, 실제 로그에서 클릭 한 번으로 케이스를 추가하게 합니다. 케이스 수가 적으므로 순위가 뒤바뀐 개수와 부트스트랩 구간으로 판정합니다 [S45].

## 요구사항: 온보딩, 내보내기·가져오기

**온보딩.**
- `npx gisul init` 한 줄로 시작합니다.
- 설치된 에이전트를 감지합니다. add-mcp SDK를 재사용할 수 있지만, 백업과 롤백 기능이 없으므로 직접 보완해야 합니다 [S55].
- 에이전트 자체 CLI(`claude mcp add`, `codex mcp add`)가 있으면 그걸 우선 씁니다.
- 쓰기 전에 변경 내용을 미리 보여주고(dry-run), 백업한 뒤 원자적으로 쓰고, `--rollback`을 제공합니다.
- 주석이 있거나 파싱되지 않는 설정 파일은 건드리지 않습니다. Claude Code 설정 파일은 동시 쓰기와 주석 때문에 MCP 설정이 통째로 지워진 사례가 있습니다 [S54].
- 지금 gisul 설치기는 이미 원자적 쓰기, 백업, 롤백을 갖추고 있습니다(`clients/runtime-install.mjs`).
- 연결 상태는 `gisul doctor`로 확인합니다. 라우터 응답, 에이전트별 MCP 항목, 폴더가 겹쳐 생긴 중복 스킬, 색인 최신 여부, 백업 시점을 점검합니다 [S6].

**내보내기·가져오기.**
- **옮기는 것과 다시 감지하는 것을 나눕니다** [S5][S57].
  - 옮기는 것: gisul 설정, 스킬 폴더 위치 정보, 평가셋, 별칭.
  - 다시 감지하는 것: 에이전트 연결, 절대 경로, 색인.
  - 기본 제외: 사용 기록과 트레이스. 프롬프트에 회사 코드나 비밀이 들어갈 수 있어서 선택 항목으로 둡니다. 실제로 `~/.claude`를 Git으로 동기화하다 약 64MB의 세션 데이터가 함께 올라간 사례가 있습니다 [S14].
- **두 방법을 함께 제공합니다.**
  - 파일 하나: 가져올 때 항목별 체크리스트를 보여주고, 기존 것을 덮어쓰지 않습니다 [S56].
  - 비공개 Git 레포: 계정이 필요 없고 다른 도구에 묶이지 않습니다 [S5].
- **새 컴퓨터 첫 실행**:
  - "새로 시작 / 백업에서 복원"을 묻습니다.
  - 로컬에 다른 내용이 있으면 "옆에 보관하고 계속"을 제공하고, 실패하면 전체를 되돌립니다 [S5].
  - 충돌이 나도 전체 동기화를 멈추지 않고, 스킬 단위로 "내 것 / 원격 / 둘 다"를 고르게 합니다 [S58].
- **복원 의미를 명시합니다.** "정확히 그대로 복원"과 "새로 해석"을 문서와 테스트로 정해 둡니다. 잘 알려진 도구도 잠금 파일 재현 옵션을 만들었다가 폐기했습니다 [S7].
- **실행 가능한 내용은 승인 후 실행합니다.** 스크립트가 든 스킬이나 훅은 새 기기에서 첫 실행 전에 변경 내용을 보여주고 승인을 받습니다 [S14].
- **digest 형식을 맞춥니다.** `/.well-known/agent-skills/index.json`의 sha256 digest 형식을 따르면 다른 도구와 호환됩니다 [S62].

## 요구사항: 패키징, 보안, 개인정보

- **배포**: npm 패키지와 Homebrew를 씁니다. MVP에서는 메뉴바 앱을 만들지 않습니다.
  - 데몬 하나가 MCP와 대시보드를 같은 출처에서 서빙하고, macOS LaunchAgent나 systemd user로 띄웁니다.
  - 단일 실행 파일은 선택 사항입니다. Bun 컴파일 결과물이 macOS arm64에서 서명 문제로 강제 종료된 사례가 반복됐으므로, 만든다면 Node SEA를 우선하고 macOS CI에서 실행 확인을 거칩니다 [S59].
- **보안**:
  - 127.0.0.1에만 바인딩하고, Host 허용 목록과 Origin을 확인해 아니면 403을 돌려줍니다. Origin만 확인해서는 DNS rebinding을 막지 못합니다 [S28][S50].
  - 변경 요청에는 JSON content-type을 요구하고, 설치마다 무작위 토큰을 발급합니다.
  - 대시보드는 같은 출처(http://127.0.0.1)에서 직접 서빙합니다. 외부 https 페이지가 localhost를 부르는 구조는 브라우저가 막습니다 [S51][S52]. 같은 출처 구조가 실제 브라우저에서 경고 없이 열리는지는 아직 직접 확인하지 않았습니다.
- **저장소**: SQLite WAL을 씁니다. Node 24.18에서 node:sqlite가 플래그 없이 동작했고, 5,000개 이벤트의 요일×시간 집계가 약 2ms, VACUUM INTO로 단일 파일 내보내기(270KB)가 됐습니다 [V1].
  - 이 API는 아직 Release Candidate 단계라 [S53], 최소 버전을 Node 24.15로 두고 시작 시 FTS5 동작을 점검합니다. 저장소는 얇은 인터페이스 뒤에 둡니다.
- **개인정보**:
  - 외부로 보내는 텔레메트리는 끕니다. 비교 대상인 Phoenix와 Langfuse는 켜져 있는 것이 기본입니다 [S60][S61].
  - 수집 수준을 세 단계로 둡니다. 메타데이터만, 마스킹, 전체 원문(옵트인)입니다. 비밀은 수집 단계에서 마스킹합니다.
  - 원문 작업 문장은 기간을 정해 보관합니다(ASSUMED 예시 90일. 비교 대상들은 무기한 보관이 기본이라 제품 판단이 필요합니다).
  - Claude Code의 원본 대화 기록은 기본 30일 뒤 삭제되므로 [S65], 기록 파일을 읽는 방식이라면 계속 수집해야 합니다.

## MVP 범위와 지표

MVP 범위는 위 요구사항과 반박 기록(debate-log D1~D8)에서 정리했습니다 [V5][S44].

**MVP에 넣는 것**
1. 계측: MCP 도구 호출 기록(후보, 점수, 핸들), Claude Code와 Codex용 OTel 수집기, Gemini, Cursor, OmO, Gajae용 수집 팩, 세션 귀속과 미귀속 버킷
2. 세션 트레이스 화면
3. 흐름도(채택 상태 기준, 데이터가 적으면 표)와 요일×시간 히트맵, 스킬×주 히트맵, 그리고 세 화면이 공유하는 세션 목록
4. 검색 개선: aliases_ko, 예시 요청, trigram, 의도 기반 질의 안내, 응답하지 않을 때의 이유 표시
5. `npx gisul init`, `gisul doctor`, 내보내기·가져오기(파일 하나)

**MVP에서 빼는 것**: 기본 탐색 대체, 리랭커, LLM 작업 분류, 메뉴바 앱, `skill://` 리소스 방식, 단일 실행 파일, Git 자동 동기화(두 번째 단계)

**지표**(목표치는 제안값입니다)
- 귀속률: Claude, Codex, Gemini의 gisul 호출 중 세션이 정해진 비율 95% 이상 (ASSUMED)
- 검색: 실제 프롬프트 평가셋에서 recall@3과 MRR, 한국어와 영어를 따로 측정. 기준선은 MVP 첫 주에 측정
- 채택률: 노출된 1위 후보가 로드된 비율
- 응답하지 않은 비율과 "맞는 스킬 없음" 요청 수
- 쓰이지 않는 스킬 비율(MEASURED 기준: 8주 동안 활성화 0회) [V5]
- 첫 성공까지 걸린 시간: 설치부터 첫 이벤트가 대시보드에 보일 때까지

**판단 지점.** 관찰자만 2주 돌린 뒤 판단합니다(ASSUMED, skeptic 제안) [V5]. 설치된 스킬의 절반 이상이 여전히 쓰이지 않고, 실제 프롬프트에서 "떠야 했는데 안 뜬" 경우가 10건 이상이면 검색과 자동 주입 작업을 확대합니다.

## 위험과 열린 질문

- **사용자 결정과 skeptic 판단의 충돌**: skeptic은 세 열 흐름도를 MVP에서 빼자고 했습니다. 사용량이 적고 결과 신호가 없다는 이유였습니다. 이 보고서는 사용자 결정을 따라 흐름도를 유지하되, 결과 열을 관찰 가능한 상태로 바꾸고 데이터가 적을 때 표를 기본으로 두는 절충안을 냈습니다. 이 절충안을 받아들일지는 사용자가 정해야 합니다.
- **문서화되지 않은 신호**: Codex의 `_meta` threadId와 sessionId는 소스 코드로만 확인했고 [S19], Claude Code의 `claudecode/toolUseId`는 2차 출처뿐입니다. 언제든 바뀔 수 있으므로 보조 수단으로만 씁니다.
- **런타임 변화**: OpenCode 2.0에서 [S24] 플러그인 API가 바뀔 예정이라 OmO 수집 팩이 깨질 수 있습니다. Codex 훅은 처음 쓸 때 신뢰 검토가 필요합니다. OpenClaw는 대화 접근 허용 설정이 따로 필요합니다.
- **한국어 검색**: 벤치마크가 없어서 모든 판단은 자체 평가셋에 달려 있습니다.
- **실험으로 확인해야 할 것**(조사로는 답할 수 없음):
  - 127.0.0.1 대시보드를 실제 브라우저에서 열어 보기
  - Node SEA로 node:sqlite 앱 빌드
  - 결과 대리 지표의 정확도(ASSUMED 50개 세션 수동 라벨링)
  - Codex PostToolUse가 MCP 도구에서도 발생하는지
  - Cursor가 MCP 호출에 붙이는 `_meta`

## 조사 방법

- 팀 8명이 축 하나씩 맡았습니다. 경쟁 서버, 이식성, 검색, 런타임 훅, 트레이스 UX, 흐름·히트맵, 로컬 배포, 반박 담당입니다.
- 별도 조사 5개를 함께 돌렸습니다. 코드베이스, 경쟁 레포 심층 분석, 사용자 불만, 기본 스킬 지원, MCP 스펙입니다.
- 확장 조사는 2회 돌렸고, 반박 담당이 주장 8건을 공격했습니다. 반박 기록은 `debate-log.md`에 있습니다.
- 다툼이 있는 기술 주장 4건은 직접 실행해 확인했습니다 [V1][V2][V3][V4].
- 제약이 두 가지 있었습니다.
  - 사용자 브라우저가 연결되지 않아 모든 웹 자료는 검색과 직접 가져오기로 읽었습니다.
  - Reddit은 접근이 막혀 HN과 GitHub로 대신했습니다.
- 실행 검증에서 뒤집힌 것이 두 가지 있습니다.
  - "Codex가 6월 이후 대화 기록 파일을 쓰지 않는다"는 관찰은 10월까지 파일이 계속 생성된 것으로 반박됐습니다 [V4].
  - "MCP 세션 ID로 세션을 묶을 수 있다"는 가정은 현재 SDK에서는 동작하지만, 최신 스펙에서 제거돼 보조 수단으로 낮췄습니다 [V2].
- 조사 기록 일체는 `claim-graph.md`, `observation-manifest.md`, `intent-diff.md`에 있습니다.

## 출처

모든 출처 접근일: 2026-10-13. V는 이 세션에서 실행한 검증 기록입니다.

- [S1] ai-rulez telemetry docs, https://github.com/Goldziher/ai-rulez/blob/main/docs/telemetry.md
- [S2] mcp-skill-hub @e7a5aa8, https://github.com/ccancellieri/mcp-skill-hub/tree/e7a5aa800616d9ecc0b1dedcfa8ffb5ab9564fe1
- [S3] skill-curator-mcp @b9e2819, https://github.com/filhocf/skill-curator-mcp/tree/b9e28196ac322080bc44e95d8e44af379df3870e
- [S4] skill-retrieval-mcp @7d034a2, https://github.com/JayCheng113/skill-retrieval-mcp/tree/7d034a2af4ac26ff7a69522ee4a3e22b865d586e
- [S5] Skills Manager README @73d6b8f, https://github.com/xingkongliang/skills-manager/tree/73d6b8f77bba6719924885c1f3be56b828d5a192
- [S6] skillshare docs, https://skillshare.runkids.cc
- [S7] getsentry/dotagents, https://github.com/getsentry/dotagents
- [S8] vercel-labs/skills README, https://github.com/vercel-labs/skills
- [S9] anthropics/claude-code #31005, https://github.com/anthropics/claude-code/issues/31005
- [S10] anthropics/claude-code #64606, https://github.com/anthropics/claude-code/issues/64606
- [S11] anthropics/claude-code #35319, https://github.com/anthropics/claude-code/issues/35319
- [S12] anthropics/claude-code #20970, https://github.com/anthropics/claude-code/issues/20970
- [S13] anthropics/claude-code #57678, https://github.com/anthropics/claude-code/issues/57678
- [S14] anthropics/claude-code #22648, https://github.com/anthropics/claude-code/issues/22648
- [S15] rulestack, 160 skills experiment, https://dev.to/rulestack/with-160-skills-installed-claude-code-kept-20-descriptions-and-the-model-found-0-of-3-skills-that-10j2
- [S16] Claude Code hooks, https://code.claude.com/docs/en/hooks.md
- [S17] Claude Code monitoring usage, https://code.claude.com/docs/en/monitoring-usage.md
- [S18] Codex hooks, https://developers.openai.com/codex/hooks
- [S19] Codex mcp_tool_call.rs @rust-v0.162.1, https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/codex-rs/core/src/mcp_tool_call.rs
- [S20] Codex skill_invocation.rs @rust-v0.162.1, https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/codex-rs/otel/src/skill_invocation.rs
- [S21] Codex skills, https://developers.openai.com/codex/skills
- [S22] Gemini CLI hooks, https://geminicli.com/docs/hooks/
- [S23] Cursor hooks, https://cursor.com/docs/agent/hooks
- [S24] OpenCode plugins, https://opencode.ai/docs/plugins/
- [S25] OpenClaw hooks, https://docs.openclaw.ai/plugins/hooks
- [S26] gajae-code @9a77bb3f docs/hooks.md, https://github.com/Yeachan-Heo/gajae-code
- [S27] MCP 2026-07-28 changelog, https://modelcontextprotocol.io/specification/2026-07-28/changelog
- [S28] MCP 2025-11-25 transports, https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- [S29] SEP-2640 Skills Extension, https://modelcontextprotocol.io/seps/2640-skills-extension
- [S30] MCP extension client matrix, https://modelcontextprotocol.io/extensions/client-matrix
- [S31] OTel GenAI agent spans @5293effb, https://github.com/open-telemetry/semantic-conventions-genai/blob/5293effb97f18ddb0602da884dadee6119d67679/docs/gen-ai/gen-ai-agent-spans.md
- [S32] LangSmith Trajectories, https://www.langchain.com/blog/langsmith-trajectories-tracing
- [S33] Braintrust examine traces, https://www.braintrust.dev/docs/observe/examine-traces
- [S34] Langfuse #9933, https://github.com/langfuse/langfuse/issues/9933
- [S35] Mixpanel Flows, https://docs.mixpanel.com/docs/reports/flows
- [S36] PostHog Paths, https://posthog.com/docs/product-analytics/paths
- [S37] GA4 Path exploration, https://support.google.com/analytics/answer/9317498
- [S38] Showing Flow (CHI 2023), https://doi.org/10.1145/3544548.3581119
- [S39] isaacs/github #627, https://github.com/isaacs/github/issues/627
- [S40] MDN Intl.Locale getWeekInfo, https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale/getWeekInfo
- [S41] SkillRet v3, https://arxiv.org/html/2605.05726v3
- [S42] Skill Is Not Document (R3-Skill), https://arxiv.org/html/2606.03565v4
- [S43] SkillRouter, https://arxiv.org/abs/2603.22455
- [S44] Skill Shadowing, https://arxiv.org/html/2605.24050v1
- [S45] When Synthetic Data Hurts, https://arxiv.org/html/2609.10750v1
- [S46] SkillReason, https://arxiv.org/abs/2608.08640
- [S47] Field Aware Agent Skill Retrieval, https://arxiv.org/html/2608.02880v2
- [S48] KURE, https://github.com/nlpai-lab/KURE
- [S49] Qwen3-Embedding, https://github.com/QwenLM/Qwen3-Embedding
- [S50] Vite GHSA-vg6x-rcgg-rjx6, https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6
- [S51] Chrome Local Network Access, https://developer.chrome.com/blog/local-network-access
- [S52] Brave localhost permission, https://brave.com/privacy-updates/27-localhost-permission
- [S53] Node.js sqlite, https://nodejs.org/docs/latest/api/sqlite.html
- [S54] anthropics/claude-code #27941, https://github.com/anthropics/claude-code/issues/27941
- [S55] add-mcp, https://github.com/neon-solutions/add-mcp
- [S56] Raycast import and export, https://manual.raycast.com/import-export
- [S57] chezmoi quick start, https://www.chezmoi.io/quick-start/
- [S58] VS Code Settings Sync, https://code.visualstudio.com/docs/configure/settings-sync
- [S59] oven-sh/bun #29120, https://github.com/oven-sh/bun/issues/29120
- [S60] Phoenix data retention, https://arize.com/docs/phoenix/settings/data-retention
- [S61] Langfuse data retention, https://langfuse.com/docs/administration/data-retention
- [S62] Agent Skills discovery RFC, https://github.com/cloudflare/agent-skills-discovery-rfc
- [S63] d3-sankey, https://github.com/d3/d3-sankey
- [S64] Anthropic Agent Skills overview, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- [S65] Claude Code .claude directory, https://code.claude.com/docs/en/claude-directory.md
- [V1] verify-node-sqlite.md (세션 디렉터리)
- [V2] verify-mcp-session-clientinfo.md (세션 디렉터리)
- [V3] verify-lexical-paraphrase.md (세션 디렉터리)
- [V4] verify-codex-transcripts.md (세션 디렉터리)
- [V6] Codex gisul 이벤트 로그 집계, ~/.codex/logs/gisul/events-20260918~20260925.jsonl (이 세션에서 실행)
- [V5] debate-log.md D2, D5, D6 (skeptic의 이 기기 집계: 스킬 폴더 4곳, 56일 활성화 수, FTS5 trigram 실행 확인)
