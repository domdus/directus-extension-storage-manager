<template>
	<collection-browser mode="storage" :storage="location" :storage-path="storagePath" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import CollectionBrowser from './components/collection-browser.vue';
import { decodeStoragePathFromUrl } from '../shared/storage-path-url';

const route = useRoute();
const location = computed(() => String(route.params.location || ''));
const storagePath = computed(() => {
	const raw = route.params.storagePath;
	const joined = Array.isArray(raw) ? raw.map(String).join('/') : String(raw || '');
	return decodeStoragePathFromUrl(joined);
});
</script>
