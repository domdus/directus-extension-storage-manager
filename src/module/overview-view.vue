<template>
	<private-view title="Storage Manager" icon="swap_horiz">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Storage Manager', to: '/storage-manager' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About">
				<p class="sidebar-text">
					Copy or move files between configured storage adapters. Physical objects are streamed via Directus
					storage drivers; database <code>id</code> and <code>filename_disk</code> stay the same.
				</p>
			</sidebar-detail>
		</template>

		<div class="page">
			<div v-if="loading && !storages.length" class="loading">
				<v-progress-circular indeterminate />
			</div>

			<v-notice v-else-if="storagesError" type="danger">{{ storagesError }}</v-notice>

			<template v-else>
				<p class="intro">
					Select a storage adapter to browse its files, or use Folders to migrate by virtual folder. Totals
					below come from <code>directus_files</code>; local adapters also report filesystem capacity when
					available.
				</p>

				<div class="cards">
					<button
						v-for="storage in storages"
						:key="storage.location"
						type="button"
						class="card"
						@click="goStorage(storage.location)"
					>
						<div class="card-head">
							<v-icon :name="storage.icon" large />
							<div class="card-titles">
								<strong>{{ storage.location }}</strong>
								<span>{{ storage.label }}</span>
							</div>
						</div>
						<usage-bar :usage="storage" />
						<div class="meta">
							<span>{{ storage.file_count.toLocaleString() }} files</span>
							<span v-if="storage.root">{{ storage.root }}</span>
						</div>
					</button>
				</div>
			</template>
		</div>
	</private-view>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ModuleNavigation from './navigation.vue';
import UsageBar from './components/usage-bar.vue';
import { useStorageManager } from './composables/use-storage-manager';

const router = useRouter();
const { storages, storagesError, loadStorages } = useStorageManager();
const loading = ref(true);

async function refresh() {
	loading.value = true;
	try {
		await loadStorages(true);
	} finally {
		loading.value = false;
	}
}

function goStorage(location: string) {
	router.push(`/storage-manager/storage/${location}`);
}

onMounted(refresh);
</script>

<style scoped>
.page {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom);
}

.loading {
	display: flex;
	justify-content: center;
	padding: 64px;
}

.intro {
	max-width: 720px;
	color: var(--theme--foreground);
	margin: 0 0 20px;
}

.sidebar-text {
	margin: 0;
	line-height: 1.45;
}

.cards {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
}

.card {
	display: flex;
	flex-direction: column;
	gap: 12px;
	text-align: left;
	padding: 16px;
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color);
	background: var(--theme--background);
	cursor: pointer;
	color: inherit;
	font: inherit;
}

.card:hover {
	border-color: var(--theme--primary);
}

.card-head {
	display: flex;
	align-items: center;
	gap: 12px;
}

.card-titles {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.card-titles span {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}

.meta {
	display: flex;
	justify-content: space-between;
	gap: 8px;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}
</style>
