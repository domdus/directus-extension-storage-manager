<template>
	<collection-browser mode="storage" :storage="location" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import CollectionBrowser from './components/collection-browser.vue';

const route = useRoute();
const location = computed(() => String(route.params.location || ''));
</script>
