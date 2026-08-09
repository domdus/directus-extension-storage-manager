<template>
	<collection-browser mode="folders" :folder="folderId || undefined" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import CollectionBrowser from './components/collection-browser.vue';

const route = useRoute();
const folderId = computed(() => {
	const id = route.params.folderId;
	return id ? String(id) : null;
});
</script>
