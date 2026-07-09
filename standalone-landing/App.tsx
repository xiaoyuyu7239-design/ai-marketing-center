import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

const PORTAL_BG =
  "https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779707217/image_1_vdzwae.png";
const CURTAIN_LEFT =
  "https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706559/curtain_left_znkmva.png";
const CURTAIN_RIGHT =
  "https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706564/curtain_right_paeyym.png";
const WORLD_BG =
  "https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706392/image_2_gkcdlx.png";
const BOTTOM_CLOUDS =
  "https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706555/bottom_clouds_xskut6.png";

const CARD_IMAGES = [
  "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260525_160507_2ccbb4eb-1469-484f-af25-59168ad9a233.png&w=1280&q=85",
  "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260525_160644_072a7f68-a101-4ded-a332-7d37707dbdd1.png&w=1280&q=85",
  "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260525_160706_1c153d04-0dfb-4ac9-a4ef-e74f301c329c.png&w=1280&q=85",
];

type ArcCard = {
  title: string;
  desc: string;
  color: string;
};

const ARC_CARDS: ArcCard[] = [
  {
    title: "Hidden Realms",
    desc: "Luminous sanctuaries unseen by wandering eyes",
    color: "#f3cdd6",
  },
  {
    title: "Wild Solitudes",
    desc: "Dissolve into untamed horizons and deep calm",
    color: "#dcedc2",
  },
  {
    title: "Silent Havens",
    desc: "Remote escapes far beyond ordinary reach",
    color: "#c3e3f4",
  },
  {
    title: "Bespoke Quests",
    desc: "Journeys shaped around your vision and soul",
    color: "#f0e4c0",
  },
  {
    title: "Vivid Drifts",
    desc: "Surreal passages through breathtaking terrain",
    color: "#dcd2f2",
  },
  {
    title: "Mystic Crests",
    desc: "Timeless ridgelines wrapped in cloud and myth",
    color: "#f3cdd6",
  },
  {
    title: "Deep Currents",
    desc: "Glowing depths alive with uncharted wonder",
    color: "#c3e3f4",
  },
  {
    title: "Gilded Dusk",
    desc: "Amber horizons that stretch past all reason",
    color: "#f0e4c0",
  },
  {
    title: "Glassy Tides",
    desc: "Calm waters holding skies of pure stillness",
    color: "#dcedc2",
  },
];

const MAG = {
  world: 6,
  clouds: 9,
  portal: 7,
  curtainL: 14,
  curtainR: 14,
};

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(media.matches);

    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return isMobile;
}

function StarLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <path
        d="M14 2l2.09 6.42H23l-5.45 3.96 2.09 6.42L14 14.84l-5.64 4.06 2.09-6.42L4.96 8.42h6.95L14 2z"
        fill="white"
        opacity="0.9"
      />
      <circle cx="14" cy="24" r="1.5" fill="white" opacity="0.6" />
      <circle cx="6" cy="6" r="1" fill="white" opacity="0.4" />
      <circle cx="22" cy="6" r="1" fill="white" opacity="0.4" />
    </svg>
  );
}

function PlayTriangle({ size = 12, color = "#3b1a0a" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.4v9.2L12.2 8 5 3.4z" fill={color} />
    </svg>
  );
}

function ScrollChevron() {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        border: "1.5px solid rgba(255,255,255,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "bobUp 1.8s ease-in-out infinite",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M3 5l4 4 4-4"
          fill="none"
          stroke="rgba(255,255,255,0.78)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function NavLink({ children, size = 12 }: { children: string; size?: number }) {
  return (
    <a
      href="#"
      style={{
        fontFamily: "'Imprima', sans-serif",
        fontSize: size,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "#ffffff",
        opacity: 0.9,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </a>
  );
}

function Navigation() {
  return (
    <nav
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        zIndex: 50,
        pointerEvents: "auto",
      }}
    >
      <div
        className="md:hidden"
      >
        <div
        style={{
          padding: "18px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <NavLink size={11}>Explore</NavLink>
        <StarLogo />
        <NavLink size={11}>Connect</NavLink>
        </div>
      </div>

      <div
        className="hidden md:block"
      >
        <div
        style={{
          padding: "22px 48px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          {["Worlds", "Atelier", "Immersions"].map((item) => (
            <NavLink key={item}>{item}</NavLink>
          ))}
        </div>
        <StarLogo />
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          {["Craft", "Codex", "Connect"].map((item) => (
            <NavLink key={item}>{item}</NavLink>
          ))}
        </div>
        </div>
      </div>
    </nav>
  );
}

function CardBlurLayer() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: "44%",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,1), transparent)",
        maskImage: "linear-gradient(to top, rgba(0,0,0,1), transparent)",
      }}
    />
  );
}

function ReelBadge({ compact = false }: { compact?: boolean }) {
  const circle = compact ? 26 : 30;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 8 : 10 }}>
      <div
        style={{
          width: circle,
          height: circle,
          borderRadius: "50%",
          background: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
        }}
      >
        <PlayTriangle size={compact ? 11 : 13} />
      </div>
      <span
        style={{
          color: "#ffffff",
          fontFamily: "'Imprima', sans-serif",
          fontSize: compact ? 13 : 18,
          lineHeight: 1,
          textShadow: "0 1px 12px rgba(0,0,0,0.7)",
          whiteSpace: "nowrap",
        }}
      >
        View Reel
      </span>
    </div>
  );
}

function MediaCard({
  image,
  index,
  size,
  radius,
  compact = false,
}: {
  image: string;
  index: number;
  size: number;
  radius: number;
  compact?: boolean;
}) {
  const isNumberCard = index === 1;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: radius,
        overflow: "hidden",
        backgroundImage: `url(${image})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        boxShadow: compact ? "0 8px 32px rgba(0,0,0,0.5)" : "0 8px 32px rgba(0,0,0,0.45)",
        flex: "0 0 auto",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "60%",
          background:
            "linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.42) 48%, transparent 100%)",
        }}
      />
      {!compact && <CardBlurLayer />}
      <div
        style={{
          position: "absolute",
          left: compact ? 12 : 12,
          right: compact ? 12 : 12,
          bottom: compact ? 12 : 12,
          color: "#ffffff",
        }}
      >
        {isNumberCard ? (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            <span
              style={{
                fontFamily: "'Viaoda Libre', serif",
                fontSize: compact ? 28 : size > 150 ? 36 : 28,
                lineHeight: 0.8,
                color: "#ffffff",
                textShadow: "0 1px 16px rgba(0,0,0,0.7)",
              }}
            >
              32
            </span>
            <span
              style={{
                fontFamily: "'Imprima', sans-serif",
                fontSize: compact ? 13 : size > 150 ? 18 : 13,
                color: "#ffffff",
                lineHeight: 1.05,
                textShadow: "0 1px 12px rgba(0,0,0,0.7)",
                whiteSpace: "nowrap",
              }}
            >
              World Patrons
            </span>
          </div>
        ) : (
          <ReelBadge compact={compact || size <= 140} />
        )}
      </div>
    </div>
  );
}

function Dots({ uiVisible, sceneOpacity }: { uiVisible: boolean; sceneOpacity: number }) {
  const delay = "0.8s";

  return (
    <>
      <div
        className="xl:hidden"
      >
        <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 28,
          zIndex: 20,
          display: "flex",
          gap: 8,
          transform: uiVisible ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(12px)",
          opacity: uiVisible ? sceneOpacity : 0,
          transition: `opacity 0.9s ease ${delay}, transform 0.9s ease ${delay}`,
          pointerEvents: "none",
        }}
      >
        {[0, 1, 2, 3].map((dot) => (
          <span
            key={dot}
            style={{
              width: dot === 0 ? 28 : 14,
              height: 4,
              borderRadius: 2,
              background: dot === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)",
            }}
          />
        ))}
        </div>
      </div>

      <div
        className="hidden xl:flex"
        style={{
          position: "absolute",
          left: 60,
          bottom: 40,
          zIndex: 20,
          gap: 8,
          transform: uiVisible ? "translateY(0)" : "translateY(12px)",
          opacity: uiVisible ? sceneOpacity : 0,
          transition: `opacity 0.9s ease ${delay}, transform 0.9s ease ${delay}`,
          pointerEvents: "none",
        }}
      >
        {[0, 1, 2, 3].map((dot) => (
          <span
            key={dot}
            style={{
              width: dot === 0 ? 28 : 14,
              height: 4,
              borderRadius: 2,
              background: dot === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)",
            }}
          />
        ))}
      </div>
    </>
  );
}

function SceneOne({ uiVisible, opacity }: { uiVisible: boolean; opacity: number }) {
  const subtext =
    "Crafting boundless digital worlds where the edge between AI, vision, and living myth dissolves.";
  const mobileFade: CSSProperties = {
    opacity: uiVisible ? 1 : 0,
    transform: uiVisible ? "translateY(0)" : "translateY(18px)",
    transition: "opacity 0.9s ease 0.3s, transform 0.9s ease 0.3s",
  };

  return (
    <section
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        opacity,
        pointerEvents: "none",
      }}
    >
      <div
        className="md:hidden"
        style={{ height: "100%" }}
      >
        <div
        style={{
          minHeight: "100%",
          padding: "80px 24px 100px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          textAlign: "center",
          ...mobileFade,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "'Viaoda Libre', serif",
              fontSize: "clamp(26px, 7vw, 42px)",
              letterSpacing: "0.12em",
              lineHeight: 1,
              color: "#3b1a0a",
            }}
          >
            FALL <span style={{ color: "#6b2e0e", fontSize: "0.8em" }}>›</span>{" "}
            <span style={{ fontStyle: "italic" }}>INTO</span>
          </div>
          <div
            style={{
              fontFamily: "'Viaoda Libre', serif",
              fontSize: "clamp(52px, 16vw, 80px)",
              letterSpacing: "-0.02em",
              lineHeight: 0.92,
              color: "#3b1a0a",
            }}
          >
            REVERIE
          </div>
        </div>

        <p
          style={{
            margin: 0,
            maxWidth: 280,
            color: "#5c2d0e",
            fontFamily: "'Imprima', sans-serif",
            fontSize: 15,
            lineHeight: 1.65,
          }}
        >
          {subtext}
        </p>

        <MediaCard image={CARD_IMAGES[0]} index={0} size={140} radius={22} compact />
        </div>
      </div>

      <div
        className="hidden md:block xl:hidden"
        style={{ height: "100%" }}
      >
        <div
        style={{
          minHeight: "100%",
          padding: "80px 32px 96px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          textAlign: "center",
          ...mobileFade,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "'Viaoda Libre', serif",
              fontSize: "clamp(28px, 5vw, 44px)",
              letterSpacing: "0.12em",
              lineHeight: 1,
              color: "#3b1a0a",
            }}
          >
            FALL <span style={{ color: "#6b2e0e", fontSize: "0.8em" }}>›</span>{" "}
            <span style={{ fontStyle: "italic" }}>INTO</span>
          </div>
          <div
            style={{
              fontFamily: "'Viaoda Libre', serif",
              fontSize: "clamp(60px, 12vw, 86px)",
              letterSpacing: "-0.02em",
              lineHeight: 0.92,
              color: "#3b1a0a",
            }}
          >
            REVERIE
          </div>
        </div>

        <p
          style={{
            margin: 0,
            maxWidth: 400,
            color: "#5c2d0e",
            fontFamily: "'Imprima', sans-serif",
            fontSize: 16,
            lineHeight: 1.65,
          }}
        >
          {subtext}
        </p>

        <div style={{ display: "flex", gap: 14 }}>
          {CARD_IMAGES.map((image, index) => (
            <MediaCard key={image} image={image} index={index} size={140} radius={22} />
          ))}
        </div>
        </div>
      </div>

      <div
        className="hidden xl:block"
        style={{
          position: "absolute",
          top: "46%",
          left: 60,
          maxWidth: 440,
          opacity: uiVisible ? 1 : 0,
          transform: uiVisible ? "translateY(-50%)" : "translateY(calc(-50% + 18px))",
          transition: "opacity 0.9s ease 0.3s, transform 0.9s ease 0.3s",
        }}
      >
        <div
          style={{
            fontFamily: "'Viaoda Libre', serif",
            fontSize: "clamp(32px, 4.5vw, 54px)",
            lineHeight: 1.1,
            letterSpacing: "0.04em",
            color: "#ffffff",
            textShadow: "0 2px 24px rgba(0,0,0,0.7), 0 1px 4px rgba(0,0,0,0.9)",
          }}
        >
          FALL <span style={{ color: "rgba(255,220,180,0.7)" }}>›</span>{" "}
          <span style={{ fontStyle: "italic" }}>INTO</span>
        </div>
        <div
          style={{
            fontFamily: "'Viaoda Libre', serif",
            fontSize: "clamp(50px, 7.5vw, 88px)",
            lineHeight: 0.9,
            letterSpacing: "-0.02em",
            color: "#ffffff",
            textShadow: "0 2px 24px rgba(0,0,0,0.7), 0 1px 4px rgba(0,0,0,0.9)",
          }}
        >
          REVERIE
        </div>
        <p
          style={{
            margin: "22px 0 0",
            maxWidth: 300,
            fontFamily: "'Imprima', sans-serif",
            fontSize: 18,
            lineHeight: 1.7,
            color: "rgba(255,245,235,0.88)",
            textShadow: "0 1px 12px rgba(0,0,0,0.8)",
          }}
        >
          {subtext}
        </p>
      </div>

      <div
        className="hidden xl:flex"
        style={{
          position: "absolute",
          right: 40,
          top: "50%",
          gap: 12,
          opacity: uiVisible ? 1 : 0,
          transform: uiVisible ? "translateY(-50%)" : "translateY(calc(-50% + 18px))",
          transition: "opacity 0.9s ease 0.55s, transform 0.9s ease 0.55s",
        }}
      >
        {CARD_IMAGES.map((image, index) => (
          <MediaCard key={image} image={image} index={index} size={158} radius={28} />
        ))}
      </div>

      <Dots uiVisible={uiVisible} sceneOpacity={1} />

      <div
        className="hidden xl:flex"
        style={{
          position: "absolute",
          bottom: 36,
          left: "50%",
          zIndex: 20,
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          opacity: uiVisible ? 1 : 0,
          transform: uiVisible ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(12px)",
          transition: "opacity 0.9s ease 0.9s, transform 0.9s ease 0.9s",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            fontFamily: "'Imprima', sans-serif",
            fontSize: 10,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          DESCEND
        </span>
        <ScrollChevron />
      </div>
    </section>
  );
}

function SceneTwo({ opacity, isMobile }: { opacity: number; isMobile: boolean }) {
  return (
    <section
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 46,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        padding: isMobile ? "8vh 28px 0" : "12vh 48px 0",
        opacity,
        pointerEvents: "none",
      }}
    >
      <h2
        style={{
          margin: 0,
          maxWidth: 820,
          fontFamily: "'Viaoda Libre', serif",
          fontSize: isMobile ? "clamp(28px, 8vw, 44px)" : "clamp(38px, 6.5vw, 78px)",
          color: "#ffffff",
          letterSpacing: "0.03em",
          lineHeight: 1.05,
          fontWeight: 400,
          textShadow: "0 2px 20px rgba(0,0,0,0.4)",
        }}
      >
        FORGE BEYOND THE REAL
      </h2>
      <p
        style={{
          margin: isMobile ? "14px 0 0" : "18px 0 0",
          maxWidth: isMobile ? 260 : 480,
          fontFamily: "'Imprima', sans-serif",
          fontSize: isMobile ? 14 : 20,
          lineHeight: 1.6,
          letterSpacing: "-0.01em",
          color: "rgba(255,255,255,0.82)",
        }}
      >
        Singular voyages to astonishing destinations, shaped for those who seek beauty beyond the ordinary and the
        known.
      </p>
    </section>
  );
}

function ArcCardSlider({
  cards,
  rotationOffset,
  isMobile,
}: {
  cards: ArcCard[];
  rotationOffset: number;
  isMobile: boolean;
}) {
  const totalCards = cards.length;
  const cardSpacingDeg = isMobile ? 12 : 9;
  const centerIndex = Math.floor(totalCards / 2);
  const arcRadius = isMobile ? 700 : 1100;
  const cardW = isMobile ? 160 : 220;
  const cardH = isMobile ? 175 : 230;
  const sliderH = isMobile ? 260 : 360;
  const halfW = cardW / 2;

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: sliderH,
        pointerEvents: "none",
      }}
    >
      {cards.map((card, i) => {
        const baseDeg = (i - centerIndex) * cardSpacingDeg;
        const deg = baseDeg - rotationOffset + centerIndex * cardSpacingDeg;
        const rad = (deg * Math.PI) / 180;
        const x = Math.sin(rad) * arcRadius;
        const y = arcRadius - Math.cos(rad) * arcRadius;

        return (
          <article
            key={card.title}
            style={{
              position: "absolute",
              bottom: -y + (isMobile ? 140 : 200),
              left: `calc(50% + ${x - halfW}px)`,
              width: cardW,
              height: cardH,
              transform: `rotate(${deg}deg)`,
              transformOrigin: `${halfW}px ${arcRadius}px`,
              borderRadius: isMobile ? 18 : 26,
              background: card.color,
              boxShadow: "0 8px 40px rgba(80,40,60,0.18)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: isMobile ? 14 : 18,
                right: isMobile ? 14 : 18,
                width: 24,
                height: 24,
                borderRadius: "50%",
                border: "1.5px solid rgba(80,50,60,0.3)",
                color: "rgba(80,50,60,0.6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "'Imprima', sans-serif",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </div>

            <div
              style={{
                position: "absolute",
                left: isMobile ? 18 : 24,
                right: isMobile ? 18 : 24,
                bottom: isMobile ? 18 : 24,
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontFamily: "'Viaoda Libre', serif",
                  fontSize: isMobile ? 22 : 30,
                  lineHeight: 0.96,
                  fontWeight: 400,
                  color: "#3a2530",
                }}
              >
                {card.title}
              </h3>
              <p
                style={{
                  margin: isMobile ? "10px 0 0" : "12px 0 0",
                  fontFamily: "'Imprima', sans-serif",
                  fontSize: isMobile ? 12 : 15,
                  lineHeight: 1.35,
                  color: "rgba(58,37,48,0.65)",
                }}
              >
                {card.desc}
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLImageElement | null>(null);
  const cloudsRef = useRef<HTMLImageElement | null>(null);
  const portalRef = useRef<HTMLImageElement | null>(null);
  const curtainLRef = useRef<HTMLImageElement | null>(null);
  const curtainRRef = useRef<HTMLImageElement | null>(null);

  const isMobile = useIsMobile();
  const [scrollProgress, setScrollProgress] = useState(0);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [curtainsOpen, setCurtainsOpen] = useState(false);
  const [uiVisible, setUiVisible] = useState(false);
  const [entranceDone, setEntranceDone] = useState(false);

  useEffect(() => {
    const openTimer = window.setTimeout(() => setCurtainsOpen(true), 100);
    const uiTimer = window.setTimeout(() => setUiVisible(true), 600);
    const doneTimer = window.setTimeout(() => setEntranceDone(true), 2200);

    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(uiTimer);
      window.clearTimeout(doneTimer);
    };
  }, []);

  useEffect(() => {
    const syncScroll = () => {
      const container = containerRef.current;
      if (!container) return;

      const maxScroll = container.scrollHeight - window.innerHeight;
      setScrollProgress(clamp(window.scrollY / maxScroll, 0, 1));
    };

    syncScroll();
    window.addEventListener("scroll", syncScroll, { passive: true });
    window.addEventListener("resize", syncScroll);

    return () => {
      window.removeEventListener("scroll", syncScroll);
      window.removeEventListener("resize", syncScroll);
    };
  }, []);

  useEffect(() => {
    const target = { x: 0, y: 0 };
    const smooth = { x: 0, y: 0 };
    let frame = 0;

    const handleMouseMove = (event: MouseEvent) => {
      if (isMobile) return;
      target.x = (event.clientX / window.innerWidth - 0.5) * 2;
      target.y = (event.clientY / window.innerHeight - 0.5) * 2;
    };

    const tick = () => {
      const speed = 0.07;
      const nextX = isMobile ? 0 : lerp(smooth.x, target.x, speed);
      const nextY = isMobile ? 0 : lerp(smooth.y, target.y, speed);

      smooth.x = nextX;
      smooth.y = nextY;
      setMouse({ x: nextX, y: nextY });
      frame = window.requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", handleMouseMove);
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.cancelAnimationFrame(frame);
    };
  }, [isMobile]);

  const computed = useMemo(() => {
    const ep = easeInOut(scrollProgress);
    const scene1Opacity = clamp(1 - scrollProgress / 0.22, 0, 1);
    const scene2Opacity = clamp((scrollProgress - 0.68) / 0.16, 0, 1);
    const cloudsOpacity = lerp(0.7, 1, clamp(scrollProgress / 0.05, 0, 1));
    const portalOpacity = scrollProgress <= 0.65 ? 1 : clamp(1 - (scrollProgress - 0.65) / 0.2, 0, 1);
    const arcSweepDeg = (ARC_CARDS.length - 1) * 10;
    const rotationOffset = lerp(0, arcSweepDeg, clamp((scrollProgress - 0.7) / 0.3, 0, 1));
    const curtainScroll = lerp(0, 150, ep);

    return {
      ep,
      scene1Opacity,
      scene2Opacity,
      cloudsOpacity,
      portalOpacity,
      rotationOffset,
      curtainScroll,
      worldScale: lerp(1, 1.18, ep),
      cloudsScale: lerp(1, 1.4, ep),
      portalScale: lerp(1, 7.5, ep),
      curtainScale: lerp(1, 1.3, ep),
    };
  }, [scrollProgress]);

  const offset = (mag: number, yDamp = 1) => ({
    x: -mouse.x * mag,
    y: -mouse.y * mag * yDamp,
  });

  const worldOffset = offset(MAG.world);
  const cloudsOffset = offset(MAG.clouds, 0.4);
  const portalOffset = offset(MAG.portal);
  const curtainLOffset = offset(MAG.curtainL, 0.3);
  const curtainROffset = offset(MAG.curtainR, 0.3);

  const curtainTransition = entranceDone ? "none" : "transform 1.8s cubic-bezier(0.16, 1, 0.3, 1)";
  const curtainLeftX = (curtainsOpen ? -62 : 0) - computed.curtainScroll;
  const curtainRightX = (curtainsOpen ? 62 : 0) + computed.curtainScroll;

  return (
    <main
      ref={containerRef}
      style={{
        position: "relative",
        height: "480vh",
        background: "#0a0608",
        overflow: "clip",
      }}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          height: "100vh",
          overflow: "hidden",
          background: "#0a0608",
        }}
      >
        <img
          ref={worldRef}
          src={WORLD_BG}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transformOrigin: "50% 50%",
            transform: `translate3d(${worldOffset.x}px, ${worldOffset.y}px, 0) scale(${computed.worldScale})`,
            willChange: "transform",
          }}
        />

        <img
          ref={cloudsRef}
          src={BOTTOM_CLOUDS}
          alt=""
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 10,
            width: "100%",
            height: "auto",
            transformOrigin: "50% 100%",
            opacity: computed.cloudsOpacity,
            transform: `translate3d(${cloudsOffset.x}px, ${cloudsOffset.y}px, 0) scale(${computed.cloudsScale})`,
            willChange: "transform, opacity",
          }}
        />

        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: isMobile ? 60 : 80,
            zIndex: 9,
            opacity: computed.scene2Opacity,
            transform: "translateX(-50%)",
            pointerEvents: "none",
          }}
        >
          <ArcCardSlider cards={ARC_CARDS} rotationOffset={computed.rotationOffset} isMobile={isMobile} />
        </div>

        <img
          ref={portalRef}
          src={PORTAL_BG}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 15,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: computed.portalOpacity,
            transformOrigin: "52% 38%",
            transform: `translate3d(${portalOffset.x}px, ${portalOffset.y}px, 0) scale(${computed.portalScale})`,
            willChange: "transform, opacity",
          }}
        />

        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 16,
            height: "40%",
            background: "linear-gradient(to top, rgba(0,0,0,0.45) 0%, transparent 100%)",
            pointerEvents: "none",
          }}
        />

        <img
          ref={curtainLRef}
          src={CURTAIN_LEFT}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 16,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "right center",
            transformOrigin: "left center",
            transition: curtainTransition,
            transform: `translateX(${curtainLeftX}%) translate3d(${curtainLOffset.x}px, ${curtainLOffset.y}px, 0) scale(${computed.curtainScale})`,
            willChange: "transform",
          }}
        />

        <img
          ref={curtainRRef}
          src={CURTAIN_RIGHT}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 16,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "left center",
            transformOrigin: "right center",
            transition: curtainTransition,
            transform: `translateX(${curtainRightX}%) translate3d(${curtainROffset.x}px, ${curtainROffset.y}px, 0) scale(${computed.curtainScale})`,
            willChange: "transform",
          }}
        />

        <SceneOne uiVisible={uiVisible} opacity={computed.scene1Opacity} />
        <SceneTwo opacity={computed.scene2Opacity} isMobile={isMobile} />

        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            zIndex: 45,
            height: "42vh",
            background: "linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, transparent 100%)",
            pointerEvents: "none",
          }}
        />

        <Navigation />
      </div>
    </main>
  );
}

export default App;
