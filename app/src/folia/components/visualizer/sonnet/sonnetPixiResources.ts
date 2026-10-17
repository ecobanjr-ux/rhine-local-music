/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/sonnet/sonnetPixiResources.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
export {
    destroyPixiContainerChildren as destroySonnetContainerChildren,
    destroyPixiDisplayTree as destroySonnetDisplayTree,
    unloadPixiDisplayTree as unloadSonnetDisplayTree,
} from '../pixiDisplayResources';
