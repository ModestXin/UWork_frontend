import type { UWorkClientPresentation } from "@zcode/shared";
import type { IClientScenesService } from "./clientScenes.js";
import { projectClientScenes } from "./clientSceneProjection.js";

export function createClientScenesService(dependencies: {
  readClientPresentation: () => Promise<UWorkClientPresentation>;
}): IClientScenesService {
  return {
    async list() {
      const view = await dependencies.readClientPresentation();
      if (view.status === "unmanaged") return { code: 0, msg: "unmanaged", data: [] };
      if (view.status !== "ready") throw new Error("enterprise_client_scenes_unavailable");
      const feature = view.scenes;
      if (feature.status !== "ready") throw new Error(`enterprise_client_scenes_${feature.status}`);
      return { code: 0, msg: "success", data: projectClientScenes(feature.data) };
    },
  };
}
