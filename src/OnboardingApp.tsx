import { useEffect, useState } from "react";

type Language = "ko" | "en";
type Provider = "Claude" | "Codex";

const TOKENCAT_PET = "./pets/tokencat-token-eater-512.png";
const CLAUDE_PET = "./pets/claude-clawd.svg";
const CODEX_PET = "./pets/codex-companion-idle.png";
const THEMES = new Set([
  "light",
  "dark",
  "stone",
  "midnight",
  "ocean",
  "forest",
  "rose",
]);

function OnboardingApp() {
  const [language] = useState<Language>(() =>
    window.localStorage.getItem("tokencat-language") === "en" ? "en" : "ko",
  );
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<Provider | null>("Claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState("0.30.0");
  const t = (korean: string, english: string) =>
    language === "en" ? english : korean;

  useEffect(() => {
    document.documentElement.lang = language;
    const savedTheme = window.localStorage.getItem("tokencat-desktop-theme");
    document.documentElement.dataset.theme =
      savedTheme && THEMES.has(savedTheme) ? savedTheme : "light";
    void window.tokenCatOnboarding
      ?.getInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {
        // The bundled version remains visible if the main process is closing.
      });
  }, [language]);

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const closed = await window.tokenCatOnboarding?.close("dismissed");
      if (!closed) window.close();
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!provider) {
      await dismiss();
      return;
    }
    if (!window.tokenCatOnboarding?.begin) {
      setError(
        t(
          "설치된 TokenCat 앱에서 계정 연결을 시작할 수 있습니다.",
          "Account connection starts from the installed TokenCat app.",
        ),
      );
      return;
    }

    setBusy(true);
    setError("");
    try {
      const started = await window.tokenCatOnboarding.begin(provider);
      if (!started) {
        setError(
          t(
            "메인 창에서 계정 연결을 시작하지 못했습니다. 다시 시도해 주세요.",
            "Could not start account connection in the main window. Try again.",
          ),
        );
        setBusy(false);
      }
    } catch {
      setError(
        t(
          "계정 연결 화면을 열지 못했습니다. 잠시 후 다시 시도해 주세요.",
          "Could not open account connection. Try again shortly.",
        ),
      );
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-app">
      <header className="onboarding-titlebar">
        <div>
          <img src={TOKENCAT_PET} alt="" draggable={false} />
          <strong>TokenCat</strong>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          aria-label={t("시작 가이드 닫기", "Close getting started guide")}
          disabled={busy}
        >
          ×
        </button>
      </header>

      <main className="onboarding-content">
        <nav
          className="onboarding-progress"
          aria-label={t("시작 가이드 단계", "Getting started steps")}
        >
          {[1, 2, 3].map((item) => (
            <span
              key={item}
              className={item <= step ? "is-active" : ""}
              aria-current={item === step ? "step" : undefined}
            >
              <i>{item}</i>
              {item === 1
                ? t("환영", "Welcome")
                : item === 2
                  ? t("계정 선택", "Choose account")
                  : t("사용 준비", "Ready")}
            </span>
          ))}
        </nav>

        {step === 1 && (
          <section
            className="onboarding-step onboarding-step--welcome"
            aria-labelledby="onboarding-heading"
          >
            <div className="onboarding-mascot">
              <img src={TOKENCAT_PET} alt="" draggable={false} />
            </div>
            <div className="onboarding-copy">
              <span>{t("처음 오셨군요", "WELCOME")}</span>
              <h1 id="onboarding-heading">
                {t(
                  "내 AI 사용량을 한눈에",
                  "Your AI usage, at a glance",
                )}
              </h1>
              <p>
                {t(
                  "TokenCat은 샘플 수치를 채워 두지 않습니다. 계정을 연결하면 Claude와 Codex의 실제 사용량만 이 PC에서 안전하게 보여 줍니다.",
                  "TokenCat starts without sample numbers. Connect an account to see only your real Claude and Codex usage, handled safely on this PC.",
                )}
              </p>
            </div>
            <div className="onboarding-benefits">
              <article>
                <b aria-hidden="true">◎</b>
                <div>
                  <strong>{t("실제 사용량", "Real usage")}</strong>
                  <span>
                    {t(
                      "5시간·주간 한도와 최신 컨텍스트 토큰",
                      "5-hour, weekly, and latest context tokens",
                    )}
                  </span>
                </div>
              </article>
              <article>
                <b aria-hidden="true">▣</b>
                <div>
                  <strong>{t("작은 데스크톱 위젯", "Compact desktop widget")}</strong>
                  <span>
                    {t(
                      "창 폭에 맞춰 가로·중간·세로로 자동 전환",
                      "Automatically adapts across horizontal, medium, and vertical layouts",
                    )}
                  </span>
                </div>
              </article>
              <article>
                <b aria-hidden="true">⌂</b>
                <div>
                  <strong>{t("내 PC에만 저장", "Stored on your PC")}</strong>
                  <span>
                    {t(
                      "프롬프트 본문과 비밀번호는 수집하지 않음",
                      "No prompt contents or passwords collected",
                    )}
                  </span>
                </div>
              </article>
            </div>
          </section>
        )}

        {step === 2 && (
          <section
            className="onboarding-step"
            aria-labelledby="onboarding-heading"
          >
            <div className="onboarding-copy">
              <span>{t("1분이면 충분해요", "TAKES ABOUT A MINUTE")}</span>
              <h1 id="onboarding-heading">
                {t("먼저 연결할 서비스를 선택하세요", "Choose a service to connect")}
              </h1>
              <p>
                {t(
                  "마지막 단계에서 기존 계정 추가 화면으로 이어집니다. 비밀번호는 TokenCat이 아닌 공식 로그인 화면에서 입력합니다.",
                  "The final step continues in the existing account setup screen. You sign in through the official provider flow, never inside TokenCat.",
                )}
              </p>
            </div>
            <div
              className="onboarding-provider-options"
              role="group"
              aria-label={t("연결할 서비스", "Service to connect")}
            >
              {(
                [
                  [
                    "Claude",
                    CLAUDE_PET,
                    t(
                      "5시간·주간 한도와 컨텍스트 토큰",
                      "5-hour, weekly, and context tokens",
                    ),
                  ],
                  [
                    "Codex",
                    CODEX_PET,
                    t(
                      "ChatGPT 플랜의 실제 사용 한도",
                      "Live limits from your ChatGPT plan",
                    ),
                  ],
                ] as Array<[Provider, string, string]>
              ).map(([item, image, description]) => (
                <button
                  type="button"
                  className={provider === item ? "is-active" : ""}
                  aria-pressed={provider === item}
                  onClick={() => {
                    setProvider(item);
                    setError("");
                  }}
                  key={item}
                >
                  <img src={image} alt="" draggable={false} />
                  <span>
                    <strong>{item}</strong>
                    <small>{description}</small>
                  </span>
                  <i aria-hidden="true">{provider === item ? "✓" : ""}</i>
                </button>
              ))}
            </div>
            <button
              className="onboarding-skip-connection"
              type="button"
              onClick={() => {
                setProvider(null);
                setStep(3);
                setError("");
              }}
            >
              {t("계정 연결은 나중에 할게요", "I’ll connect an account later")}
            </button>
          </section>
        )}

        {step === 3 && (
          <section
            className="onboarding-step"
            aria-labelledby="onboarding-heading"
          >
            <div className="onboarding-copy">
              <span>{t("마지막 안내", "ONE LAST THING")}</span>
              <h1 id="onboarding-heading">
                {provider
                  ? t(
                      `${provider} 연결을 시작할 준비가 됐어요`,
                      `Ready to connect ${provider}`,
                    )
                  : t("이제 TokenCat을 둘러보세요", "You’re ready to explore TokenCat")}
              </h1>
              <p>
                {provider
                  ? t(
                      "계정 별칭을 정한 뒤 공식 로그인을 마치면 실제 사용량이 자동으로 표시됩니다.",
                      "Choose an account alias and finish the official sign-in. Your real usage will then appear automatically.",
                    )
                  : t(
                      "빈 대시보드의 ‘계정 추가’ 또는 설정의 계정 탭에서 언제든 연결할 수 있습니다.",
                      "Connect anytime from Add account on the empty dashboard or the Accounts tab in Settings.",
                    )}
              </p>
            </div>
            <div className="onboarding-ready-list">
              <article>
                <i aria-hidden="true">1</i>
                <span>
                  <strong>{t("공식 로그인", "Official sign-in")}</strong>
                  <small>
                    {t(
                      "Claude/Codex CLI가 인증 정보를 직접 관리합니다",
                      "The Claude or Codex CLI manages credentials directly",
                    )}
                  </small>
                </span>
              </article>
              <article>
                <i aria-hidden="true">2</i>
                <span>
                  <strong>{t("자동 최신화", "Automatic refresh")}</strong>
                  <small>
                    {t(
                      "다음 사용 뒤 새 한도와 토큰이 자동 반영됩니다",
                      "New limits and tokens appear after your next use",
                    )}
                  </small>
                </span>
              </article>
              <article>
                <i aria-hidden="true">3</i>
                <span>
                  <strong>{t("트레이에서 관리", "Manage from the tray")}</strong>
                  <small>
                    {t(
                      "설정·항상 위·업데이트를 우클릭으로 제어합니다",
                      "Right-click for Settings, always-on-top, and updates",
                    )}
                  </small>
                </span>
              </article>
            </div>
            {error && (
              <p className="onboarding-error" role="alert">
                {error}
              </p>
            )}
          </section>
        )}
      </main>

      <footer className="onboarding-actions">
        {step === 1 ? (
          <>
            <button
              type="button"
              className="is-secondary"
              onClick={() => void dismiss()}
              disabled={busy}
            >
              {t("나중에", "Maybe later")}
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => setStep(2)}
              autoFocus
            >
              {t("시작하기", "Get started")}
              <span aria-hidden="true">→</span>
            </button>
          </>
        ) : step === 2 ? (
          <>
            <button
              type="button"
              className="is-secondary"
              onClick={() => setStep(1)}
            >
              {t("이전", "Back")}
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => setStep(3)}
              disabled={!provider}
            >
              {t("다음", "Next")}
              <span aria-hidden="true">→</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="is-secondary"
              onClick={() => setStep(2)}
              disabled={busy}
            >
              {t("이전", "Back")}
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => void finish()}
              disabled={busy}
            >
              {busy
                ? t("여는 중…", "Opening…")
                : provider
                  ? t(`${provider} 연결 시작`, `Connect ${provider}`)
                  : t("TokenCat 열기", "Open TokenCat")}
              {!busy && <span aria-hidden="true">→</span>}
            </button>
          </>
        )}
      </footer>

      <span className="onboarding-version">TokenCat v{version}</span>
    </div>
  );
}

export default OnboardingApp;
