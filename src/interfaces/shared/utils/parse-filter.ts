import type { Accountability, Filter } from '@directus/types';
import { parseFilter as parseFilterShared } from '@directus/utils';
import { useStores } from '@directus/extensions-sdk';

export function parseFilter(filter: Filter | null): Filter {
	const { currentUser } = useStores().useUserStore();

	if (!currentUser || !('id' in currentUser)) return filter ?? {};

	const accountability = {
		role: currentUser.role?.id ?? null,
		roles: currentUser.roles?.map((role) => role.id) ?? [],
		user: currentUser.id,
	} as Accountability;

	return (
		parseFilterShared(filter, accountability, {
			$CURRENT_ROLE: currentUser.role ?? undefined,
			$CURRENT_ROLES: currentUser.roles,
			$CURRENT_USER: currentUser,
		}) ?? {}
	);
}
