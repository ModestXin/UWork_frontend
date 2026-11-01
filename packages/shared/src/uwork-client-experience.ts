import { z } from "zod";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const localized = (maximum: number) =>
  z
    .object({ cn: text(maximum).optional(), en: text(maximum).optional() })
    .strict()
    .refine((value) => Boolean(value.cn || value.en), "A localized value is required");
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
const bytesWithin = (maximum: number) => (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
const id = text(64);
const icon = text(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const template = z
  .object({
    id,
    title: localized(100),
    prompt: localized(4000),
    icon: icon.optional(),
  })
  .strict();

/** The UI builder's lossless cron subset; this does not schedule or execute work. */
export function isUWorkEditableTemplateCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const number = (value: string, maximum: number, minimum = 0) =>
    /^(?:0|[1-9]\d*)$/u.test(value) && Number(value) >= minimum && Number(value) <= maximum;
  const interval = (value: string, maximum: number) =>
    /^\*\/[1-9]\d*$/u.test(value) && number(value.slice(2), maximum, 1);
  if (month !== "*") return false;
  if (interval(minute, 59)) return hour === "*" && day === "*" && weekday === "*";
  if (!number(minute, 59)) return false;
  if (hour === "*") return day === "*" && weekday === "*";
  if (interval(hour, 24)) return day === "*" && weekday === "*";
  if (!number(hour, 23)) return false;
  if (day !== "*") return weekday === "*" && (number(day, 31, 1) || interval(day, 31));
  if (weekday === "*" || weekday === "1-5") return true;
  const days = weekday.split(",");
  return (
    days.every((value) => number(value, 6)) &&
    unique(days) &&
    days.join(",") === [...days].sort((left, right) => Number(left) - Number(right)).join(",")
  );
}

export const uworkScenesConfigurationSchema = z
  .object({
    draftSuggestions: z
      .array(
        template
          .extend({
            actions: z
              .array(z.enum(["NAVIGATE:AUTOMATIONS", "NAVIGATE:AUTOMATIONS:OFFPEAK"]))
              .max(2)
              .refine(unique, "Duplicate actions")
              .optional(),
            // Metadata only: never projected into the legacy plugin-install defaults grammar.
            pluginStableId: text(200).optional(),
          })
          .strict(),
      )
      .max(20)
      .refine((items) => unique(items.map((item) => item.id)), "Duplicate IDs"),
    scheduledTemplates: z
      .array(
        template
          .extend({
            cronExpr: text(100)
              .transform((value) => value.replace(/\s+/gu, " "))
              .refine(isUWorkEditableTemplateCron, "Cron cannot be edited without loss"),
          })
          .strict(),
      )
      .max(20)
      .refine((items) => unique(items.map((item) => item.id)), "Duplicate IDs"),
    offPeakTemplates: z
      .array(
        template
          .extend({ description: localized(1000).optional() })
          .strict()
          .refine(
            (item) => item.id.replace(/^item[-_]?/iu, "").toLowerCase() !== "customize",
            "Reserved template ID",
          ),
      )
      .max(20)
      .refine((items) => unique(items.map((item) => item.id)), "Duplicate IDs"),
  })
  .strict()
  .refine(bytesWithin(128 * 1024), "Scenes exceed 128 KiB");

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url())
  .refine((value) => {
    // z.url 的格式失败仍会运行 refine；safeParse 不能因无效管理输入抛 TypeError。
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "HTTPS without credentials is required");

export const uworkHelpConfigurationSchema = z
  .object({
    communityUrls: z
      .object({ "zh-CN": httpsUrl.nullable(), "en-US": httpsUrl.nullable() })
      .strict(),
    feedback: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("disabled"), url: z.null() }).strict(),
      z.object({ mode: z.literal("external"), url: httpsUrl }).strict(),
    ]),
  })
  .strict()
  .refine(bytesWithin(16 * 1024), "Help exceeds 16 KiB");

export const uworkDesktopConfigurationSchema = z
  .object({
    desktopContextPrompt: z.object({ enabled: z.boolean() }).strict(),
    rendererActionTrace: z
      .object({
        enabled: z.boolean(),
        sampleRatio: z.number().finite().min(0).max(0.2),
        enabledGroups: z
          .array(z.enum(["core", "settings", "workbench", "extensions", "automation", "account"]))
          .max(6)
          .refine(unique, "Duplicate trace groups"),
      })
      .strict(),
  })
  .strict();

const orderIds = z.array(text(200)).refine(unique, "Duplicate order IDs");
const modeOrder = z
  .object({
    categoryOrder: orderIds.max(64).optional(),
    pluginOrder: z
      .unknown()
      // record 解析会丢弃 __proto__；必须在解析前拒绝，不能保存成功却静默丢分类。
      .refine(
        (value) =>
          value === null || typeof value !== "object" || !Object.hasOwn(value, "__proto__"),
        "Unsupported order key",
      )
      .pipe(
        z
          .record(
            z
              .string()
              .min(1)
              .max(200)
              .refine((value) => value === value.trim(), "Order keys must already be trimmed"),
            orderIds.max(100),
          )
          .refine((value) => Object.keys(value).length <= 64, "Too many order categories"),
      )
      .optional(),
  })
  .strict();
export const uworkPluginStoreConfigurationSchema = z
  .object({
    order: z.object({ code: modeOrder.optional(), work: modeOrder.optional() }).strict().nullable(),
  })
  .strict()
  .refine(bytesWithin(64 * 1024), "Plugin store order exceeds 64 KiB");

export type UWorkScenesConfiguration = z.infer<typeof uworkScenesConfigurationSchema>;
export type UWorkHelpConfiguration = z.infer<typeof uworkHelpConfigurationSchema>;
export type UWorkDesktopConfiguration = z.infer<typeof uworkDesktopConfigurationSchema>;
export type UWorkPluginStoreConfiguration = z.infer<typeof uworkPluginStoreConfigurationSchema>;

export function uworkPublishedFeatureSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("status", [
    z
      .object({ status: z.literal("ready"), version: z.number().int().nonnegative(), data })
      .strict(),
    z.object({ status: z.literal("unsupported") }).strict(),
    z.object({ status: z.literal("unavailable") }).strict(),
  ]);
}
export type UWorkPublishedFeature<T> =
  | { status: "ready"; version: number; data: T }
  | { status: "unsupported" }
  | { status: "unavailable" };
