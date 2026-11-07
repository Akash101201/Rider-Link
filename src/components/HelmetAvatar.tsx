interface HelmetAvatarProps {
  color: string;
  speaking?: boolean;
  muted?: boolean;
  size?: number;
}

export function HelmetAvatar({
  color,
  speaking = false,
  muted = false,
  size = 42,
}: HelmetAvatarProps) {
  return (
    <div
      className={`helmet-avatar-wrap ${speaking ? 'is-speaking' : ''} ${muted ? 'is-muted' : ''}`}
      style={{
        width: size,
        height: size,
        ['--rider-accent' as string]: color,
      }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width={size} height={size} fill="none">
        {/* Helmet shell */}
        <path
          d="M11 38C10.5 23.5 20 13 34 13C44.5 13 52.5 19.8 54 31L54.8 37.5C55.1 40.5 53.3 43.2 50.5 44.3L34.5 50.8C30.6 52.2 26.2 51.9 22.5 49.7L14.5 44.8C12.3 43.4 11.2 40.8 11 38Z"
          fill="#161C26"
          stroke={muted ? '#525E70' : color}
          strokeWidth="3.2"
          strokeLinejoin="round"
        />
        {/* Aero crown stripe */}
        <path
          d="M20 17.5C26 14.5 34.5 14.5 41 17.8L37 23.2C32.2 21 26.2 21 22 22.8L20 17.5Z"
          fill={muted ? '#525E70' : color}
        />
        {/* Tinted visor */}
        <path
          d="M28.5 25.5H51.5L53.2 35.5L33.5 39.2C29.8 39.8 26.6 37 27 33.2L27.5 27.2C27.6 26.2 28 25.5 28.5 25.5Z"
          fill={speaking ? '#00E676' : '#00E5FF'}
          fillOpacity={muted ? 0.12 : 0.28}
          stroke={speaking ? '#00E676' : '#00E5FF'}
          strokeOpacity={muted ? 0.35 : 0.9}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        {/* Bluetooth comms pod LED */}
        <circle
          cx="27.5"
          cy="44.5"
          r="3.2"
          fill={muted ? '#FF3D57' : speaking ? '#00E676' : color}
        />
      </svg>
    </div>
  );
}

