/** Crescent-moon glyph used for the Moonlight launch option (original artwork). */
export const MoonIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
    <path
      fill="currentColor"
      d="M14.5 2.2a9.8 9.8 0 1 0 7.3 13.9 8.2 8.2 0 0 1-7.3-13.9Z"
    />
    <circle cx="17.6" cy="5.4" r="1.1" fill="currentColor" opacity="0.75" />
    <circle cx="20.4" cy="9.6" r="0.7" fill="currentColor" opacity="0.6" />
  </svg>
);
