export interface ResourceState<T> {
  key: string;
  revision: number;
  data: T | null;
  error: string;
}
export function resourceSnapshot<T>(
  state: ResourceState<T> | null,
  key: string,
  revision: number,
  enabled: boolean,
) {
  const matches = state?.key === key;
  const data = enabled && matches ? state.data : null;
  const pending = enabled && (!matches || state.revision !== revision);
  return {
    data,
    error: enabled && matches && state.revision === revision ? state.error : "",
    loading: pending && data === null,
    refreshing: pending && data !== null,
  };
}
export function failedResourceState<T>(
  previous: ResourceState<T> | null,
  key: string,
  revision: number,
  error: unknown,
): ResourceState<T> {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : 0;
  const mayRetain = ![401, 403, 404].includes(status);
  return {
    key,
    revision,
    data: mayRetain && previous?.key === key ? previous.data : null,
    error: error instanceof Error ? error.message : "Unable to load data",
  };
}
