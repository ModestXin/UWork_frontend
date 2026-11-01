import type { UWorkScenesConfiguration } from "@zcode/shared";
import type { ClientSceneConfig, ClientSceneItem, ClientSceneOption } from "./clientScenes.js";

type Template = UWorkScenesConfiguration["draftSuggestions"][number];
const option = (id: string, items: ClientSceneItem[]): ClientSceneOption => ({
  id,
  type: id,
  contents: {},
  items,
});
const item = (value: Template): ClientSceneItem => ({
  id: value.id,
  type: "prompt",
  contents: value.prompt,
  labels: value.title,
  ...(value.icon ? { img: value.icon } : {}),
});

/** Only generated legacy view fields; normalized publication cannot inject arbitrary options. */
export function projectClientScenes(data: UWorkScenesConfiguration): ClientSceneConfig[] {
  const scene = (name: string, options: Record<string, ClientSceneOption>): ClientSceneConfig => ({
    namespace: "uwork",
    scene: name,
    options,
  });
  return [
    scene("draft-suggestion", {
      prompts: option(
        "prompts",
        data.draftSuggestions.map((value) => ({
          ...item(value),
          ...(value.actions?.length ? { on_finish: value.actions.join(",") } : {}),
          // Opaque metadata is matched to the existing installed catalog only in the UI.
          ...(value.pluginStableId ? { pluginStableId: value.pluginStableId } : {}),
        })),
      ),
    }),
    scene("scheduled-task", {
      prompts: option(
        "prompts",
        data.scheduledTemplates.map((value) => ({
          ...item(value),
          defaults: { cronExpr: [`cron:${value.id}`] },
        })),
      ),
      cronExpr: option(
        "cronExpr",
        data.scheduledTemplates.map((value) => ({
          id: `cron:${value.id}`,
          type: "cronExpr",
          labels: {},
          contents: { cn: value.cronExpr, en: value.cronExpr },
        })),
      ),
    }),
    scene("off-peak-task", {
      prompts: option(
        "prompts",
        data.offPeakTemplates.map((value) => ({
          ...item(value),
          ...(value.description ? { descs: value.description } : {}),
        })),
      ),
    }),
  ];
}
