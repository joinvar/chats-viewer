import { useId } from "react";
import type { Source } from "../api";

// Shared tool glyphs. Originally lived inside SourceSelect; pulled out so the
// project / session lists can tag each row with the tool it came from in the
// aggregated ("all") view.
export function ToolIcon({ source, size = 18 }: { source: Source; size?: number }) {
  if (source === "codex") return <CodexIcon size={size} />;
  if (source === "cursor") return <CursorIcon size={size} />;
  if (source === "grok") return <GrokIcon size={size} />;
  if (source === "antigravity") return <AntigravityIcon size={size} />;
  if (source === "orca") return <OrcaIcon size={size} />;
  return <ClaudeIcon size={size} />;
}

// A little stacked badge for the aggregated view's selector entry.
export function AllToolsIcon({ size = 18 }: { size?: number }) {
  return (
    <span
      className="tool-stack"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <span className="tool-stack-a">
        <ClaudeIcon size={Math.round(size * 0.72)} />
      </span>
      <span className="tool-stack-b">
        <CodexIcon size={Math.round(size * 0.72)} />
      </span>
    </span>
  );
}

export function OrcaIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="#163A4A"
        d="M2.8 13.2c1.6-5.4 7.2-8 12.6-6.2 2.2.7 3.8 2.2 4.8 3.6-1.3.2-2.4 1.1-2.8 2.3.9.2 1.7.8 2.2 1.6-1.6 1.5-3.8 2.1-5.8 1.6-1.1 2.2-3.3 3.5-5.9 3.3-3.3-.3-5.7-2.7-6.3-5.4-.3-.8 0-1.4 1.2-.8z"
      />
      <path
        fill="#F7F4EF"
        d="M8.4 14.6c1.7 1.6 4.3 1.8 6.3.7-1.6 1.1-3.8.8-5.2-.5-1-.9-1.5-1.4-1.1-.2z"
      />
      <circle cx="15.4" cy="10.1" r=".85" fill="#F7F4EF" />
    </svg>
  );
}

export function ClaudeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="#D97757"
        d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
      />
    </svg>
  );
}

export function CodexIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="#1f1e1c"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

export function CursorIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="#1f1e1c"
        d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
      />
    </svg>
  );
}

// Official Grok (xAI) mark — same approach as Claude / Codex / Cursor above:
// brand SVG path inlined (via @lobehub/icons-static-svg `grok.svg`, viewBox 0 0 24 24).
// The mark is the singularity / accretion “G”, not a filled circle — so it won’t
// read as another OpenAI-style blob next to Codex.
// Official Antigravity full-color arch (press “Icon - Full Color” / lobe `antigravity-color.svg`).
export function AntigravityIcon({ size = 18 }: { size?: number }) {
  const uid = useId().replace(/:/g, "");
  const m = `${uid}m`;
  const f = (n: number) => `${uid}f${n}`;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <mask id={m} maskUnits="userSpaceOnUse" x="0" y="1" width="24" height="23">
        <path
          fill="#fff"
          d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
        />
      </mask>
      <g mask={`url(#${m})`}>
        <g filter={`url(#${f(1)})`}>
          <path fill="#FFE432" d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" />
        </g>
        <g filter={`url(#${f(2)})`}>
          <path fill="#FC413D" d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" />
        </g>
        <g filter={`url(#${f(3)})`}>
          <path fill="#00B95C" d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" />
        </g>
        <g filter={`url(#${f(4)})`}>
          <path fill="#00B95C" d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z" />
        </g>
        <g filter={`url(#${f(5)})`}>
          <path fill="#3186FF" d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" />
        </g>
        <g filter={`url(#${f(6)})`}>
          <path fill="#FBBC04" d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" />
        </g>
        <g filter={`url(#${f(7)})`}>
          <path fill="#3186FF" d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z" />
        </g>
        <g filter={`url(#${f(8)})`}>
          <path fill="#749BFF" d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z" />
        </g>
        <g filter={`url(#${f(9)})`}>
          <path fill="#FC413D" d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" />
        </g>
        <g filter={`url(#${f(10)})`}>
          <path fill="#FFEE48" d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z" />
        </g>
      </g>
      <defs>
        <filter id={f(1)} x="-3.288" y="-11.917" width="19.838" height="17.587" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="1.117" />
        </filter>
        <filter id={f(2)} x="4.251" y="-13.493" width="38.9" height="38.565" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="5.4" />
        </filter>
        <filter id={f(3)} x="-21.889" y="-10.592" width="40.955" height="36.517" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="4.591" />
        </filter>
        <filter id={f(4)} x="-19.099" y="-10.278" width="36.632" height="36.595" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="4.591" />
        </filter>
        <filter id={f(5)} x=".981" y="8.758" width="33.533" height="34.087" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="4.363" />
        </filter>
        <filter id={f(6)} x="-6.143" y="-21.659" width="35.978" height="35.276" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="3.954" />
        </filter>
        <filter id={f(7)} x="-11.96" y="-.46" width="45.114" height="46.523" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="3.531" />
        </filter>
        <filter id={f(8)} x="10.485" y=".58" width="25.094" height="24.054" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="3.159" />
        </filter>
        <filter id={f(9)} x="5.833" y="-12.467" width="33.508" height="30.007" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="2.669" />
        </filter>
        <filter id={f(10)} x="-8.355" y="-8.876" width="22.194" height="26.151" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="3.303" />
        </filter>
      </defs>
    </svg>
  );
}

export function GrokIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="#1f1e1c"
        fillRule="evenodd"
        d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"
      />
    </svg>
  );
}
