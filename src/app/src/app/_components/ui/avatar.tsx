"use client";

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  email?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
};

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.split(" ").filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "?";
}

function initialsColor(text: string): string {
  let hash = 0;
  for (const ch of text) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

export function Avatar({ src, name, email, size = "md", className = "" }: AvatarProps) {
  const initials = getInitials(name, email);
  const sz = sizeClasses[size];

  if (src) {
    return (
      <img
        src={src}
        alt={name ?? email ?? "Avatar"}
        className={`${sz} rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div
      className={`${sz} flex items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{ backgroundColor: initialsColor(name ?? email ?? "?") }}
    >
      {initials}
    </div>
  );
}
