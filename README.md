# Escape the Cave (동굴 탈출)

> **빛이 곧 생존 자원이자 위험**이 되는 1인칭 절차적 복셀 동굴 탈출 게임 — 컴퓨터그래픽스 기말 과제.
> 무너진 동굴에 갇혀 **빛을 관리하며 열쇠 조각 3개**를 모아 **출구**로 탈출하세요. 어둠 속 고블린은 손전등 불빛에 이끌려 다가옵니다.

## ▶ 브라우저에서 바로 플레이

**https://i1uvmango.github.io/escape_the_cave_computerGraphics/**

![게임플레이](res/gameplay1.gif)

![게임플레이 2](res/gameplay2.gif)

> 링크가 404면, 소유자가 **GitHub Pages를 1회 활성화**해야 합니다:
> 레포 **Settings → Pages → Source = `main` 브랜치 / `/ (root)`** → Save 후 약 1분 대기.

## 주요 특징

- **절차적 복셀 동굴** — 방 + 복도 carving으로 걷기 가능 보장, `cave.json`으로 사전 베이크.
- **Surface Nets** 매끈한 메시 + **Triplanar PBR**(Rock035, CC0) — UV 없이 3축 투영.
- **실시간 간접광(GI)** — 강의 DDGI를 웹에 맞게 단순화한 **probe 기반 확산 GI**(메시 + `three-mesh-bvh` 광선추적 + 시간적 누적). 글로우스톤을 놓으면 빛이 **모퉁이를 돌아** 퍼집니다.
- **실시간 그림자** — 가장 가까운 글로우스톤 1개 기준, 플레이어·고블린 그림자.
- **Mixamo 고블린**(FBX 걷기 애니메이션) — 손전등 빛에 이끌려 추격.
- 손전등 **배터리(3분)**, **글로우스톤(10개 한정)**, 하트 체력, 나침반, 지나온 경로 **지도(M)**, 튜토리얼.

## 조작

| 입력 | 동작 |
|---|---|
| `WASD` | 이동 (`Shift+W` 달리기) |
| `Space` | 점프 |
| 마우스 | 시점 |
| 좌클릭 | 손전등 켜기/끄기 |
| 우클릭 | 글로우스톤 설치 |
| `F` | 열쇠 줍기(조준) |
| `M` | 지도(지나온 경로) |
| `P` | GI probe 격자 표시(디버그) |
| `B` | 음악 켜기/끄기 |
| `Esc` | 마우스 잠금 해제 |

## 로컬 실행

빌드 도구 없음 — 정적 서버로 열기만 하면 됩니다(ES 모듈/`fetch` 때문에 `file://` 더블클릭은 안 됨):

```bash
python3 -m http.server 8000
# 게임:        http://localhost:8000/game.html
# 생성기 도구:  http://localhost:8000/generator.html
```

## 리포트

전체 설명: [report.md](report.md) — 강의(L4 Lighting / L5 Texture / L6 Animation / L8 GI) 내용과 구현을 매핑하고, 각 항목을 게임 캡처로 설명합니다.

## 기술 · 크레딧

- **three.js**(WebGL2), **three-mesh-bvh**(충돌 + GI 광선추적), **lil-gui**(생성기 도구).
- 바위 텍스처: **Rock035, ambientCG (CC0)**. 고블린: **Mixamo (Adobe)**. 손전등 모델·나침반: AI 생성.
