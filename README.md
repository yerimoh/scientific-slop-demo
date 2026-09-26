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
cp .env.example .env        # OPENROUTER_API_KEY 입력 (기본 모델: openai/gpt-5.6-luna)
./run.sh                    # http://localhost:8811
```

키가 없어도 규칙 기반 4개 measure는 동작하고, 리포트에 "partial"로 표시됩니다.

CLI:

```bash
uv run python cli.py ../_ICLR_2027__Scientific_Slop            # LaTeX 디렉터리
uv run python cli.py paper.pdf --json report.json
uv run python cli.py https://arxiv.org/abs/2303.17651
```

OpenAI 호환 엔드포인트라면 무엇이든 쓸 수 있습니다 (`SCISLOP_LLM_BASE_URL`, `SCISLOP_MODEL`). 로컬 vLLM으로 테스트할 때는 `SCISLOP_LLM_EXTRA='{"chat_template_kwargs":{"enable_thinking":false}}'`.

## 구조

```
server.py            FastAPI: /api/analyze, /api/jobs/{id}, /api/jobs/{id}/figure, 정적 페이지
cli.py               커맨드라인 채점
engine/latex.py      LaTeX 리더: \input 확장, 주석 제거, 사용자 매크로 확장, structure view + prose view
engine/pdf.py        PDF 리더: 2단 레이아웃 순서, 헤딩/캡션/수식 번호, hyperref 링크 + 인쇄된 참조, 인용 파싱
engine/fetch.py      업로드/링크 처리 (arXiv는 e-print 소스 우선, 실패 시 PDF), 안전한 압축 해제
engine/measures.py   6개 measure + aggregate
engine/llm.py        OpenRouter 클라이언트, structured outputs, (model, prompt, run) 해시 디스크 캐시
static/              index.html, app.css, app.js (빌드 없음)
data/                작업별 리포트(job.json), 렌더링된 figure, LLM 캐시
```

## 논문 대비 달라진 점 (UI에도 표시됨)

- **Argument graph**: 논문은 Qwen2.5-7B의 log-probability로 PMI를 계산해 각 claim의 supporting sentence를 고릅니다. OpenRouter의 gpt-5.6-luna는 logprob을 주지 않으므로, claim마다 나머지 Introduction 문장을 **무작위 순서 + 중립 ID**로 보여 주고 LLM이 하나를 고르게 했습니다. 위치 정보가 없으니 선택이 문장 순서에 끌리지 않습니다 (PMI처럼 (context, claim) 쌍만 보고 판단). claim 라벨은 논문처럼 3회 다수결입니다.
- **Citation isolation**: 논문의 "frozen cue list"가 공개되어 있지 않아, 관계 cue 목록을 재구성했습니다 (`engine/text.py`).
- **Figure exposition**: method figure는 caption gate(overview / pipeline / framework / architecture / workflow / schematic)로 고릅니다. 통과하는 figure가 없으면 N/A이며, 리포트에서 사용자가 직접 figure를 골라 채점할 수 있습니다.
- **PDF 입력**: 논문의 Agents4Science 처리와 같이 PDF에서 구조를 복원합니다. LaTeX로 만든 PDF는 hyperref 내부 링크로 `\ref`/`\eqref`를 거의 그대로 복원합니다. arXiv 4편(DetectGPT, Self-Refine, Binoculars, Attention)에서 PDF와 LaTeX 결과를 비교해 섹션 구성과 Evidence gap이 일치하고, Cross-section references 차이는 0.02–0.08입니다.
- **Index 구간**(Low < 20 ≤ Moderate < 40 ≤ High < 60 ≤ Very high)은 서술용 구분이며, 보정된 AI 확률이 아닙니다. 논문의 AI 확률은 FARS 쌍에 대한 logistic fit인데, 그 데이터가 여기 없기 때문입니다.

## 배포 (scislop.open-galapagos.com, Render + Cloudflare)

`render.yaml`은 Render Blueprint입니다 (Docker web service `scislop`, Free plan, 커스텀 도메인 포함).

1. Render Dashboard → **New → Blueprint** → `Open-Galapagos/science-slop-index` 선택 → `OPENROUTER_API_KEY` 입력 → Apply.
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
