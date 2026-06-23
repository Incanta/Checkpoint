interface Props {
  /** Diameter in pixels. */
  size?: number;
  /** Ring thickness in pixels. */
  thickness?: number;
}

// A smooth conic-gradient ring spinner used across the app's loading and
// connecting states. Relies on the global `cp-spin` keyframe in index.css.
export default function Spinner({
  size = 48,
  thickness = 4,
}: Props): React.ReactElement {
  const ring = `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness}px))`;

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        background:
          "conic-gradient(from 90deg, rgba(100,108,255,0) 0%, #646cff 100%)",
        WebkitMask: ring,
        mask: ring,
        animation: "cp-spin 0.9s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}
