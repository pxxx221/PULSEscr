// Keyboard layout transliteration helper: converts Russian (ЙЦУКЕН) keypresses to English (QWERTY)
const RU_TO_EN_MAP: Record<string, string> = {
  // Lowercase letters
  'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i', 'щ': 'o', 'з': 'p',
  'х': '[', 'ъ': ']', 'ф': 'a', 'ы': 's', 'в': 'd', 'а': 'f', 'п': 'g', 'р': 'h', 'о': 'j', 'л': 'k',
  'д': 'l', 'ж': ';', 'э': "'", 'я': 'z', 'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm',
  'б': ',', 'ю': '.', 'ё': '`',

  // Uppercase letters
  'Й': 'Q', 'Ц': 'W', 'У': 'E', 'К': 'R', 'Е': 'T', 'Н': 'Y', 'Г': 'U', 'Ш': 'I', 'Щ': 'O', 'З': 'P',
  'Х': '{', 'Ъ': '}', 'Ф': 'A', 'Ы': 'S', 'В': 'D', 'А': 'F', 'П': 'G', 'Р': 'H', 'О': 'J', 'Л': 'K',
  'Д': 'L', 'Ж': ':', 'Э': '"', 'Я': 'Z', 'Ч': 'X', 'С': 'C', 'М': 'V', 'И': 'B', 'Т': 'N', 'Ь': 'M',
  'Б': '<', 'Ю': '>', 'Ё': '~',
};

/**
 * Automatically converts any Russian keyboard input to English QWERTY characters.
 * Also cleans punctuation and uppercase for ticker search purposes.
 */
export function convertRuToEnLayout(text: string): string {
  return text
    .split('')
    .map((char) => RU_TO_EN_MAP[char] || char)
    .join('');
}
