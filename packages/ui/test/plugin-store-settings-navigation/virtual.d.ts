declare module "virtual:actual-plugin-navigation" {
  type Environment = Readonly<Record<string, unknown>>;
  export function useActualExit(environment: Environment): () => void;
  export function useActualNavigate(environment: Environment): () => void;
  export function useActualTaskOpen(environment: Environment): () => void;
  export function useActualScopeOpen(environment: Environment): (target?: object) => void;
  export function actualSettingsBrowse(
    environment: Environment,
  ): (returnScope?: string, intent?: "add-marketplace") => void;
}
