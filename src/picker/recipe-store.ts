import { browser } from 'wxt/browser';
import { siteKey } from '@/src/shared/url';
import { isRecipe, recipeKey, type Recipe } from './recipe';

/**
 * Penyimpanan recipe. Dipisah dari `recipe.ts` supaya bagian yang memutuskan
 * (selector, sidik jari) tetap murni dan bisa dites tanpa `storage`.
 *
 * `storage.local`, bukan IndexedDB: isinya beberapa ratus byte per situs, dan
 * content script perlu membacanya sebelum halaman dianggap siap.
 */

export async function loadRecipe(url: string): Promise<Recipe | null> {
  const key = recipeKey(siteKey(url));
  try {
    const stored = await browser.storage.local.get(key);
    const value = stored[key];
    return isRecipe(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveRecipe(recipe: Recipe): Promise<void> {
  try {
    await browser.storage.local.set({ [recipeKey(recipe.siteKey)]: recipe });
  } catch {
    // Recipe bersifat mempercepat, bukan syarat: gagal menyimpan bukan alasan
    // menggagalkan pengambilan yang sudah berhasil.
  }
}

export async function clearRecipe(url: string): Promise<void> {
  try {
    await browser.storage.local.remove(recipeKey(siteKey(url)));
  } catch {
    /* diabaikan */
  }
}
