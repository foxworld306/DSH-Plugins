/**
 * Skins: the palette half of "自由发挥".
 *
 * The archetypes read the token names (navy / lime / panel / ink …), not literal hex, so a skin is
 * just a different mapping for those names plus a different seed (master + theme). The SUEZ mapping
 * stays the default and is restored after every build.
 */
export const DEFAULT_PALETTE = {
  navy: '030F40',
  lime: 'AADC14',
  limeInk: '6B7C00',
  blue: '77B7FC',
  tint: '80B1E0',
  amber: 'FFC229',
  orange: 'F67536',
  panel: 'F2F5FA',
  grid: 'D9E0EA',
  ink: '333F55',
  mid: '5A6B8C',
  muted: '7A87A0',
  white: 'FFFFFF',
};

export const SKINS = {
  suez: {
    label: 'SUEZ 模板',
    free: false,
    seed: null,
    palette: DEFAULT_PALETTE,
  },
  editorial: {
    label: '编辑部：暖纸底、深红强调、字距紧',
    free: true,
    seed: 'editorial.pptx',
    palette: {
      navy: '1A1A1A',
      lime: 'E8B4B8',        // on the dark field
      limeInk: '8C2F39',     // on paper
      blue: '2F4858',
      tint: 'C9BFB0',
      amber: 'B8860B',
      orange: 'C0504D',
      panel: 'F3EFE7',
      grid: 'DCD5C8',
      ink: '2A2A2A',
      mid: '6B6459',
      muted: '8A8378',
      white: 'FFFFFF',
    },
  },
  tech: {
    label: '技术：深底、薄荷绿强调、等宽数字感',
    free: true,
    seed: 'tech.pptx',
    palette: {
      navy: '0B0F14',
      lime: '3DDC97',        // on the dark field
      limeInk: '0B7A52',     // on light panels
      blue: '2E6BE6',
      tint: 'A9BACC',
      amber: 'FFC229',
      orange: 'FF7A45',
      panel: 'E9F0F7',       // light card surface, so dark ink stays readable
      grid: 'C9D6E2',
      ink: '16202B',
      mid: '4E6076',
      muted: '7A8A9B',
      white: 'FFFFFF',
    },
  },
  minimal: {
    label: '极简：纯白、单色强调、大留白',
    free: true,
    seed: 'minimal.pptx',
    palette: {
      navy: '141414',
      lime: 'E5484D',        // the one accent, readable on both fields
      limeInk: 'C8102E',
      blue: 'C8102E',
      tint: 'B3B3B3',
      amber: 'C8102E',
      orange: 'C8102E',
      panel: 'F4F4F4',
      grid: 'E2E2E2',
      ink: '1F1F1F',
      mid: '6F6F6F',
      muted: '8C8C8C',
      white: 'FFFFFF',
    },
  },
};

export function skinFor(name) {
  const key = String(name ?? 'suez').toLowerCase();
  return SKINS[key] ? { name: key, ...SKINS[key] } : null;
}
