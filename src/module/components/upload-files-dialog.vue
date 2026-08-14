<template>
	<v-dialog :model-value="modelValue" @update:model-value="onOpenChange" @esc="close">
		<v-card>
			<v-card-title>{{ title }}</v-card-title>
			<v-card-text>
				<div
					class="upload-zone"
					:class="{ dragging: zoneDragging, uploading }"
					data-dropzone
					@click="browse"
					@dragenter.prevent="onZoneDragEnter"
					@dragover.prevent
					@dragleave.prevent="onZoneDragLeave"
					@drop.prevent.stop="onZoneDrop"
				>
					<template v-if="uploading">
						<v-progress-circular indeterminate />
						<p>Uploading…</p>
					</template>
					<template v-else>
						<v-icon large :name="zoneDragging ? 'file_download' : 'file_upload'" />
						<p>{{ zoneDragging ? 'Drop files to upload' : 'Drag and drop files here' }}</p>
						<p class="hint">or click to browse from your device</p>
					</template>
					<input
						ref="fileInput"
						class="hidden-input"
						type="file"
						multiple
						@change="onBrowseChange"
						@click.stop
					/>
				</div>
			</v-card-text>
			<v-card-actions>
				<v-button @click="close">Done</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
/**
 * File Library–style Add File dialog: dropzone + click to browse
 * (instead of instantly opening the OS file picker).
 */
import { ref } from 'vue';

withDefaults(
	defineProps<{
		modelValue: boolean;
		title?: string;
		uploading?: boolean;
	}>(),
	{
		title: 'Add File',
		uploading: false,
	},
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'files', files: globalThis.File[]): void;
}>();

const fileInput = ref<HTMLInputElement | null>(null);
const zoneDragging = ref(false);
let zoneDragCounter = 0;

function close() {
	emit('update:modelValue', false);
}

function onOpenChange(open: boolean) {
	emit('update:modelValue', open);
	if (!open) {
		zoneDragging.value = false;
		zoneDragCounter = 0;
	}
}

function browse() {
	fileInput.value?.click();
}

function emitFiles(list: FileList | globalThis.File[] | null | undefined) {
	const files = Array.from(list || []).filter((file) => Boolean(file.type) || file.size > 0);
	if (files.length) emit('files', files);
}

function onBrowseChange(event: Event) {
	const input = event.target as HTMLInputElement;
	emitFiles(input.files);
	input.value = '';
}

function onZoneDragEnter() {
	zoneDragCounter++;
	if (zoneDragCounter === 1) zoneDragging.value = true;
}

function onZoneDragLeave() {
	zoneDragCounter--;
	if (zoneDragCounter <= 0) {
		zoneDragCounter = 0;
		zoneDragging.value = false;
	}
}

function onZoneDrop(event: DragEvent) {
	zoneDragCounter = 0;
	zoneDragging.value = false;
	emitFiles(event.dataTransfer?.files);
}
</script>

<style scoped>
.upload-zone {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 8px;
	min-block-size: 12.5rem;
	padding: 2rem 1.5rem;
	color: var(--theme--foreground-subdued);
	text-align: center;
	cursor: pointer;
	background-color: var(--theme--background);
	border: var(--theme--border-width) dashed var(--theme--form--field--input--border-color);
	border-radius: var(--theme--border-radius);
	transition:
		border-color var(--fast) var(--transition),
		color var(--fast) var(--transition),
		background-color var(--fast) var(--transition);
}

.upload-zone:hover,
.upload-zone.dragging {
	color: var(--theme--primary);
	background-color: var(--theme--primary-background);
	border-color: var(--theme--primary);
}

.upload-zone.uploading {
	pointer-events: none;
	cursor: default;
}

.upload-zone p {
	margin: 0;
	color: inherit;
}

.upload-zone .hint {
	font-size: 13px;
	opacity: 0.85;
}

.hidden-input {
	position: absolute;
	inline-size: 0;
	block-size: 0;
	opacity: 0;
	pointer-events: none;
}
</style>
