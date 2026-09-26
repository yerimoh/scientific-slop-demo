# Science Slop Index

논문 한 편(PDF, LaTeX 소스, arXiv / OpenReview 링크)을 넣으면 *Science or Slop?* (ICLR 2027 submission)의 6가지 scientific slop 측정을 돌려 **Science Slop Index (0–100)** 와 근거 위치를 보여주는 웹사이트입니다.

```
S(p) = plane 평균( plane 안에서 적용 가능한 measure 평균 )      # Appendix A, Eq. slop-aggregate
index = round(100 · S(p))
```

| Plane | Measure | 방식 | 단위 |
|---|---|---|---|
| Structure | Cross-section references | 규칙 | 섹션 + 라벨된 figure/table/equation/algorithm/theorem |
| Structure | Macro redundancy | 규칙 | 8토큰 이상 문장 (이전 다른 섹션의 8-gram이 ≥50%) |
| Argument | Argument graph | LLM | Introduction의 key claim |
| Argument | Citation isolation | 규칙 | Intro + Related Work의 인용 문장 |
| Artifacts | Figure exposition | LLM (vision) | method figure의 6가지 expository kind |
| Artifacts | Evidence gap | 규칙 | 논문 (본문 result table이 있을 때만 적용) |

## 실행

```bash
cp .env.example .env        # LITELLM_PROXY_API_KEY 입력 (UMN AI gateway, 모델 gpt-5.6-luna)
./run.sh                    # http://localhost:8811
```

키가 없어도 규칙 기반 4개 measure는 동작하고, 리포트에 "partial"로 표시됩니다.

CLI:

```bash
uv run python cli.py ../_ICLR_2027__Scientific_Slop            # LaTeX 디렉터리
uv run python cli.py paper.pdf --json report.json
uv run python cli.py https://arxiv.org/abs/2303.17651
```

LLM은 `LITELLM_PROXY_API_BASE`가 있으면 LiteLLM gateway(기본: UMN AI gateway), 없으면 OpenRouter(`OPENROUTER_API_KEY`)를 씁니다. 그 밖의 OpenAI 호환 엔드포인트도 됩니다 (`SCISLOP_LLM_BASE_URL`, `SCISLOP_MODEL`). 로컬 vLLM으로 테스트할 때는 `SCISLOP_LLM_EXTRA='{"chat_template_kwargs":{"enable_thinking":false}}'`.

## 웹사이트 기능

- **홈** `/`: 링크 입력 또는 PDF / LaTeX 업로드(업로드는 "List uploaded paper in the gallery"를 체크해야 갤러리에 올라감).
- **리포트** `/r/<key>`: 진행률 바, 지수와 세 영역 점수, Findings 탭(논문 맵, 여섯 지표의 위치 목록), Paper 탭(PDF 페이지 위 하이라이트, 지표별 켜고 끄기, 클릭하면 해당 발견으로 이동), Export(하이라이트된 PDF + 요약 표지, JSON, CSV).
- **Report key**: 분석마다 `xxxx-xxxx-xxxx` 키가 발급됨. `/view`에서 키로 다시 열기, 이 브라우저의 최근 리포트, 내려받은 JSON 다시 열기.
- **리더보드** `/leaderboard`: 등록된 논문(갤러리와 같은 목록)을 Science Slop Index 순으로 세운 막대 차트. 막대는 세 영역의 기여분으로 쌓이고, 지표 전환(지수 / 영역 / 여섯 지표), "N of M papers"(Top N 또는 직접 선택), 출처 필터, 표 보기, PNG 저장, 현재 보기 링크 복사(`?metric=&n=&exclude=&view=`)를 지원.
- **갤러리** `/gallery`: 공개 링크로 분석한 논문과 공개를 선택한 업로드, 첫 페이지 썸네일과 순위("Slop #n"), 검색과 정렬.
- **How it works** `/how`: 논문 Table 1 형식의 지표 표(그림 포함), 논문이 보고한 벤치마크, 계산식, 논문과 다른 점.

저장: `data/jobs/<key>/`에 job.json, files/(paper.pdf, highlighted.pdf, thumb.png, 페이지 이미지, figure 이미지). 업로드 원본 소스는 분석 후 삭제됩니다.
`seed/`는 코드와 함께 배포되는 갤러리 기본 논문(공개 링크로 분석한 6편)이며, PDF는 원래 링크에서 필요할 때 다시 받아 옵니다.
Render Free는 디스크가 휘발성이라 새로 분석한 리포트와 키는 재시작하면 사라집니다(`SCISLOP_PERSISTENT=1` + 영구 디스크를 쓰면 유지).

## 구조

```
server.py            FastAPI: /api/analyze, /api/jobs/{id}, /api/jobs/{id}/figure, 정적 페이지
cli.py               커맨드라인 채점
engine/latex.py      LaTeX 리더: \input 확장, 주석 제거, 사용자 매크로 확장, structure view + prose view
engine/pdf.py        PDF 리더: 2단 레이아웃 순서, 헤딩/캡션/수식 번호, hyperref 링크 + 인쇄된 참조, 인용 파싱
engine/fetch.py      업로드/링크 처리 (arXiv는 e-print 소스 우선, 실패 시 PDF), 안전한 압축 해제
engine/measures.py   6개 measure + aggregate
engine/llm.py        LLM 클라이언트(LiteLLM gateway / OpenRouter / OpenAI 호환), structured outputs, 디스크 캐시, 진행률 카운터
engine/highlight.py  발견 위치를 PDF 단어 좌표에 매칭, 하이라이트 PDF(+요약 표지), 썸네일, 페이지 이미지
static/              index.html, app.css, app.js (빌드 없음), img/ (논문 Table 1 그림)
seed/                갤러리 기본 리포트
data/                작업별 리포트(job.json), 렌더링된 figure, LLM 캐시
```

## 논문 대비 달라진 점 (UI에도 표시됨)

- **Argument graph**: 논문은 Qwen2.5-7B의 log-probability로 PMI를 계산해 각 claim의 supporting sentence를 고릅니다. gpt-5.6-luna 호출에서는 logprob을 쓰지 않으므로, claim마다 나머지 Introduction 문장을 **무작위 순서 + 중립 ID**로 보여 주고 LLM이 하나를 고르게 했습니다. 위치 정보가 없으니 선택이 문장 순서에 끌리지 않습니다 (PMI처럼 (context, claim) 쌍만 보고 판단). claim 라벨은 논문처럼 3회 다수결입니다.
- **Citation isolation**: 논문의 "frozen cue list"가 공개되어 있지 않아, 관계 cue 목록을 재구성했습니다 (`engine/text.py`).
- **Figure exposition**: method figure는 caption gate(overview / pipeline / framework / architecture / workflow / schematic)로 고릅니다. 통과하는 figure가 없으면 N/A이며, 리포트에서 사용자가 직접 figure를 골라 채점할 수 있습니다.
- **PDF 입력**: 논문의 Agents4Science 처리와 같이 PDF에서 구조를 복원합니다. LaTeX로 만든 PDF는 hyperref 내부 링크로 `\ref`/`\eqref`를 거의 그대로 복원합니다. arXiv 4편(DetectGPT, Self-Refine, Binoculars, Attention)에서 PDF와 LaTeX 결과를 비교해 섹션 구성과 Evidence gap이 일치하고, Cross-section references 차이는 0.02–0.08입니다.
- **Index 구간**(Low < 20 ≤ Moderate < 40 ≤ High < 60 ≤ Very high)은 서술용 구분이며, 보정된 AI 확률이 아닙니다. 논문의 AI 확률은 FARS 쌍에 대한 logistic fit인데, 그 데이터가 여기 없기 때문입니다.

## 배포 (scislop.open-galapagos.com, Render + Cloudflare)

현재 배포: https://scislop.open-galapagos.com (Render 서비스 `scislop`, `srv-das3lnrbc2fs7396k9i0`; Cloudflare DNS-only CNAME `scislop` → `scislop.onrender.com`).
`render.yaml`은 같은 구성을 새로 만들 때 쓰는 Render Blueprint입니다 (Docker web service, Free plan, 커스텀 도메인 포함).

1. Render Dashboard → **New → Blueprint** → `Open-Galapagos/science-slop-index` 선택 → `OPENROUTER_API_KEY` 입력 → Apply.
   (UMN AI gateway는 교내망 전용이라 Render에서는 닿지 않습니다. 공개 서비스는 OpenRouter, 로컬 실행은 UMN gateway를 씁니다.)
   (Render GitHub App이 이 repo에 접근할 수 있어야 합니다. 안 보이면 GitHub → Settings → Applications → Render → Repository access에 추가.)
2. 배포가 끝나면 서비스 주소(`https://scislop-xxxx.onrender.com`)를 확인합니다.
3. Cloudflare → `open-galapagos.com` → DNS → **Add record**: `CNAME`, 이름 `scislop`, 대상 `scislop-xxxx.onrender.com`, Proxied.
4. Render 서비스 → Settings → Custom Domains에서 `scislop.open-galapagos.com`이 Verified가 되면 끝입니다.

공개 서버 보호 장치 (환경 변수로 조정):
`SCISLOP_RATE_PER_HOUR`(IP당 시간당 분석 수, 기본 20), `SCISLOP_MAX_CONCURRENT`(동시 분석, 기본 2), `SCISLOP_MAX_UPLOAD_MB`(기본 50).
업로드된 파일은 분석이 끝나면 삭제되고, 리포트(job.json)와 렌더링된 figure만 남습니다.
링크는 주소가 사설 IP로 가는지 리다이렉트마다 확인합니다.

Free plan 주의: 15분간 요청이 없으면 잠들고(다음 접속 약 1분), 디스크가 휘발성이라 재시작·재배포 때 저장된 리포트 링크(`/r/<id>`)가 사라집니다.
리포트를 오래 보관하려면 Starter + Render Disk, 또는 외부 저장소(Supabase/HF bucket)가 필요합니다.
