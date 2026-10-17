<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a></p>

# gisool

gisool은 로컬 스킬 라우터다. `127.0.0.1`에서 도는 데몬 하나가 이 머신에 이미 있는 `SKILL.md` 폴더를 MCP로 코딩 에이전트에 제공한다. 세션마다 어떤 스킬을 검색하고, 불러오고, 읽었는지 기록하고 로컬 대시보드로 보여준다. 외부로는 아무것도 나가지 않는다.

이름은 기술(skill, craft, technique)에서 왔다.

## 30초 시작

macOS 또는 Linux, Node.js 24.15 이상.

```sh
npm --prefix local ci && npm --prefix local run build && npm link ./local
gisool init --dry-run    # 바뀔 설정을 전부 미리 보기, 아무것도 쓰지 않음
gisool init              # 감지된 런타임 연결 + 백그라운드 서비스 설치
gisool open              # 대시보드 열기
```

`gisool init`은 LaunchAgent(macOS) 또는 systemd 사용자 유닛(Linux)을 설치해 데몬을 포트 `8799`로 계속 띄워둔다. 포그라운드로 돌리려면 `gisool init --no-service` 후 `gisool serve`.

## 지원 런타임

| 런타임 | `--runtime` id |
| --- | --- |
| Claude Code | `claude-code` |
| Codex | `codex` |
| Gemini CLI | `gemini` |
| Cursor | `cursor` |
| OmO | `omo` |
| Gajae Code | `gajae` |
| OpenClaw | `openclaw` |

`gisool init`이 설치된 런타임을 감지한다. 일부만 연결하려면 `gisool init --runtime codex,claude-code`. 런타임마다 MCP 항목, 데몬으로 보내는 OpenTelemetry 로그, 캡처 훅이 설정된다.

MCP 연결에는 프로토콜 리비전 2026-07-28과 호스트 리소스 리더가 필요하다. 레거시 `initialize` 핸드셰이크를 쓰는 클라이언트는 연결되지 않는다. 자세한 내용: [local/README.md](local/README.md).

## 무엇을 어디에 기록하나

- 에이전트 세션별 프롬프트, 스킬 검색(쿼리와 순위 후보), 스킬 로드, 보조 파일 읽기.
- 런타임이 gisool 없이 직접 쓴 스킬(훅이나 텔레메트리가 알려줄 때).

모두 `~/.gisool/` 아래 SQLite에 저장된다(`GISOOL_HOME`으로 위치 변경). 데몬은 `127.0.0.1`에서만 듣고, 모든 요청에 로컬 bearer 토큰이 필요하며, 원격 서비스로는 아무것도 보내지 않는다. 스킬 폴더는 제자리에서 색인한다. 복사하거나 고치지 않는다.

`~/.gisool/config.json`의 `captureLevel`은 `full`(기본), `redacted`(비밀값 마스킹, 2048자로 자름), `metadata`(텍스트 없이 다이제스트와 길이만). `retentionDays`로 오래된 세션을 지운다.

| 경로 | 용도 |
| --- | --- |
| `~/.gisool/config.json` | 설정: 포트, 캡처 수준, 보존 기간, 스킬 루트 |
| `~/.gisool/token` | bearer 토큰 (0600) |
| `~/.gisool/gisool.db` | 스킬 색인, 세션, 이벤트, 로드 |
| `~/.gisool/logs/daemon.log` | 데몬 로그 |
| `~/.gisool/backups/` | 롤백용 실행별 설정 백업 |

## 대시보드

```sh
gisool open              # 브라우저로 열기
gisool open --print      # URL만 출력
```

세션 목록, 검색 후보까지 보이는 세션별 트레이스, 작업 -> 스킬 -> 결과 흐름, 요일x시간 히트맵.

## 점검, 되돌리기, 옮기기

```sh
gisool doctor                                  # 서비스, 데몬, 토큰, FTS5, 루트, 색인, 훅, 백업
gisool doctor --json
gisool init --rollback                         # 마지막 init 되돌리기
gisool init --rollback --all                   # 전부 되돌리기
gisool export ~/gisool-backup                  # 설정만
gisool export ~/gisool-backup --with-history   # 세션과 이벤트까지
gisool import ~/gisool-backup --dry-run        # 미리 보기, 기존 키는 덮어쓰지 않음
gisool eval                                    # 검색 품질 측정
```

전체 CLI, 설정, 프로토콜: [local/README.md](local/README.md). 아키텍처: [docs/gisool.md](docs/gisool.md).

## 원격 레지스트리 (선택)

이 저장소에는 팀 배포용 인증 원격 레지스트리 gisul도 있다. 여러 머신에서 스킬을 공유해야 할 때만 쓴다. gisool에는 필요 없다. `gisool init --disable-remote`는 연결된 런타임의 원격 gisul 등록을 끈다.

- `server/`: 스킬 디렉터리를 stdio 또는 Streamable HTTP로 제공하는 Node.js MCP 서버(기본 `http://127.0.0.1:8788/mcp`).
- `worker/`: 비공개 R2 버킷의 불변 릴리스를 제공하는 인증 Cloudflare Worker.

```text
Git main -> GitHub Actions validation/evaluation -> immutable R2 release
                                                       ^
Codex plugin / MCP client -> authenticated Worker -------+
```

| 런타임 | 클라이언트 | 연결 |
| --- | --- | --- |
| Codex | [ARKPOINT 플러그인](docs/arkpoint-plugin.md) | 네이티브 HTTPS + OAuth |
| oh-my-openagent / OmO 5 (`omo-ai`) | [설치기와 로더](clients/oh-my-openagent/README.md) | OAuth stdio 브리지, 탐색 확장 |
| Gajae Code (`gjc`) | [설치기와 워크플로 연동](clients/gajae-code/README.md) | OAuth stdio 브리지 |
| OpenClaw | [번들과 로더](clients/openclaw/README.md) | OAuth stdio 브리지, 부트스트랩 탐색 훅 |

두 서버 모두 [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)을 구현한다. Worker는 `SKILLS_BUCKET`, 읽기용 `GISUL_BEARER_TOKEN`, 게시용 별도 `GISUL_PUBLISH_TOKEN`을 쓴다. 저장소에 실제 비밀값은 없다. `server/ops/`는 템플릿이다.

- 배포, 릴리스 형식, 롤백, 프로덕션 게이트: [docs/deployment.md](docs/deployment.md)
- Codex 플러그인: [clients/codex/README.md](clients/codex/README.md)
- 세션 인수인계 맥락: [docs/SESSION_CONTEXT.md](docs/SESSION_CONTEXT.md)

원격 레지스트리는 개인 프로토타입이다. 프로덕션 승인에는 GitHub Actions 게시 성공, 설치된 플러그인의 실제 읽기, 일치하는 릴리스 증거가 필요하다.

## 라이선스

[MIT](LICENSE)
