<script setup lang="ts">
const props = defineProps<{
  content: string
}>()

const blocks = computed(() => parseMarkdownBlocks(props.content))
</script>

<template>
  <div class="md-body">
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="block.type === 'heading' ? `h${Math.min(4, block.level + 1)}` : 'div'" v-if="block.type === 'heading'" class="md-heading">
        <template v-for="(span, sIndex) in block.spans" :key="sIndex">
          <strong v-if="span.kind === 'bold'">{{ span.text }}</strong>
          <code v-else-if="span.kind === 'code'">{{ span.text }}</code>
          <span v-else-if="span.kind === 'timestamp'" class="md-ts">{{ span.text }}</span>
          <template v-else>{{ span.text }}</template>
        </template>
      </component>

      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.type === 'list'" class="md-list">
        <li v-for="(item, iIndex) in block.items" :key="iIndex" :class="{ 'md-task': item.checked !== undefined }">
          <span v-if="item.checked !== undefined" class="md-check" :class="{ checked: item.checked }">
            {{ item.checked ? '✓' : '' }}
          </span>
          <span>
            <template v-for="(span, sIndex) in item.spans" :key="sIndex">
              <strong v-if="span.kind === 'bold'">{{ span.text }}</strong>
              <code v-else-if="span.kind === 'code'">{{ span.text }}</code>
              <span v-else-if="span.kind === 'timestamp'" class="md-ts">{{ span.text }}</span>
              <template v-else>{{ span.text }}</template>
            </template>
          </span>
        </li>
      </component>

      <p v-else class="md-paragraph">
        <template v-for="(span, sIndex) in block.spans" :key="sIndex">
          <strong v-if="span.kind === 'bold'">{{ span.text }}</strong>
          <code v-else-if="span.kind === 'code'">{{ span.text }}</code>
          <span v-else-if="span.kind === 'timestamp'" class="md-ts">{{ span.text }}</span>
          <template v-else>{{ span.text }}</template>
        </template>
      </p>
    </template>
  </div>
</template>
