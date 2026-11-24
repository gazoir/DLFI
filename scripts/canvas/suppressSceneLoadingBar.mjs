/**
 * Suppress Foundry's scene texture-loading progress toast ("Loading …")
 * for every client. Always on — no setting.
 *
 * Same approach as the Suppress Loading Message module:
 * TextureLoader.load(..., { displayProgress: false }).
 */

import { MODULE_ID } from "../constants.mjs";

/**
 * Patch the shared TextureLoader instance once Foundry has created it.
 */
export function registerSuppressSceneLoadingBar() {
  const Loader = foundry?.canvas?.TextureLoader;
  const loader = Loader?.loader;
  if (!loader || typeof loader.load !== "function") {
    console.warn(
      `${MODULE_ID} | TextureLoader unavailable — cannot suppress scene loading bar`
    );
    return;
  }
  if (loader.__dlfiSuppressProgress) {
    return;
  }
  loader.__dlfiSuppressProgress = true;

  const original = loader.load.bind(loader);
  loader.load = async function dlfiSuppressProgressLoad(sources, options = {}) {
    return original(sources, { ...options, displayProgress: false });
  };

  console.log(`${MODULE_ID} | scene loading progress bar suppressed`);
}
