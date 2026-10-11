/** Bundled characters served from public/dots/<id>.png. */
export const BUILTIN_AVATARS = [
  { id: 'blue', label: 'Blue' },
  { id: 'mint', label: 'Mint' },
  { id: 'orange', label: 'Orange' },
  { id: 'purple', label: 'Purple' },
  { id: 'vasanth', label: 'Vasanth' },
] as const;
export const BUILTIN_AVATAR_IDS: readonly string[] = BUILTIN_AVATARS.map(
  (avatar) => avatar.id,
);
export function isBuiltinAvatar(id: string) {
  return BUILTIN_AVATAR_IDS.includes(id);
}
/** Uploaded avatars are served by the app; bundled ones are static files. */
export function avatarSrc(id: string) {
  return isBuiltinAvatar(id)
    ? `/dots/${id}.png`
    : `/avatars/${encodeURIComponent(id)}.png`;
}
/** Square edge for uploaded avatars, matching the bundled PNGs. */
export const AVATAR_SIZE = 512;
