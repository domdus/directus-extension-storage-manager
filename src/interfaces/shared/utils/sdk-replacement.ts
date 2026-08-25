import { useApi } from '@directus/extensions-sdk';

export function requestEndpoint(path: string, config?: { params?: Record<string, unknown> }) {
	return { path, config };
}

/** Minimal stand-in for app `@/sdk` used by relation composables. */
const sdk = {
	async request<T>(endpoint: { path: string; config?: { params?: Record<string, unknown> } }): Promise<T> {
		const api = useApi();
		const response = await api.get(endpoint.path, endpoint.config);
		return response.data?.data as T;
	},
};

export default sdk;
