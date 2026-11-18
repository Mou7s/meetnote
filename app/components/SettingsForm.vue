<script setup lang="ts">
import type { ConfigTestResult, UserConfig } from '../../shared/types'
import type { ConfigTestPayload, PersonalSettingsPayload } from '../composables/useWorkspace'

const props = defineProps<{
  config: UserConfig
  settingsSaved: boolean
  busy: boolean
  testConnection: (payload: ConfigTestPayload) => Promise<ConfigTestResult>
}>()

const emit = defineEmits<{
  save: [payload: PersonalSettingsPayload, enterWorkspace: boolean]
  skip: []
}>()

const aliyunModels = ['qwen-audio-3.1-asr-flash-streaming', 'fun-asr-realtime', 'paraformer-realtime-v2']
const aliyunHostPresets = [
  { label: '北京默认', value: 'dashscope.aliyuncs.com' },
  { label: '新加坡', value: 'dashscope-intl.aliyuncs.com' }
]
const deepseekModelPresets = ['deepseek-flash', 'deepseek-chat']

const form = reactive<PersonalSettingsPayload>({
  aliyunKey: '',
  deepseekKey: '',
  clearAliyun: false,
  clearDeepseek: false,
  aliyunHost: props.config.aliyunHost,
  aliyunModel: props.config.aliyunModel,
  deepseekModel: props.config.deepseekModel
})

const showAliyunKey = ref(false)
const showDeepseekKey = ref(false)
const testingAsr = ref(false)
const testingAi = ref(false)
const asrTestResult = ref<ConfigTestResult | null>(null)
const aiTestResult = ref<ConfigTestResult | null>(null)

const canTestAsr = computed(() => !testingAsr.value && (!!form.aliyunKey.trim() || (props.config.asr && !form.clearAliyun)))
const canTestAi = computed(() => !testingAi.value && (!!form.deepseekKey.trim() || (props.config.ai && !form.clearDeepseek)))

watch(
  () => props.config,
  value => {
    form.aliyunKey = ''
    form.deepseekKey = ''
    form.clearAliyun = false
    form.clearDeepseek = false
    form.aliyunHost = value.aliyunHost
    form.aliyunModel = value.aliyunModel
    form.deepseekModel = value.deepseekModel
  }
)

watch(
  () => [form.aliyunKey, form.aliyunHost, form.aliyunModel, form.clearAliyun],
  () => {
    asrTestResult.value = null
  }
)

watch(
  () => [form.deepseekKey, form.deepseekModel, form.clearDeepseek],
  () => {
    aiTestResult.value = null
  }
)

async function runTestAsr() {
  if (!canTestAsr.value) return
  testingAsr.value = true
  asrTestResult.value = null
  try {
    asrTestResult.value = await props.testConnection({
      service: 'asr',
      aliyunKey: form.aliyunKey.trim() || undefined,
      useSaved: props.config.asr && !form.clearAliyun && !form.aliyunKey.trim(),
      aliyunHost: form.aliyunHost,
      aliyunModel: form.aliyunModel
    })
  } finally {
    testingAsr.value = false
  }
}

async function runTestAi() {
  if (!canTestAi.value) return
  testingAi.value = true
  aiTestResult.value = null
  try {
    aiTestResult.value = await props.testConnection({
      service: 'ai',
      deepseekKey: form.deepseekKey.trim() || undefined,
      useSaved: props.config.ai && !form.clearDeepseek && !form.deepseekKey.trim(),
      deepseekModel: form.deepseekModel
    })
  } finally {
    testingAi.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">OPEN. CONNECT. START.</span>
      <h1>填入密钥，开始你的会议。</h1>
      <p class="muted">无需注册或登录。连接自己的模型服务，调用费用由你的服务商账号承担。</p>
    </div>
  </div>

  <UAlert
    v-if="!config.encryptionReady"
    color="warning"
    variant="soft"
    title="服务端尚未配置主加密密钥"
    description="当前可在此页面测试模型连通性，但无法保存密钥。请在服务端 .env 中配置 64 位十六进制 USER_KEYS_ENCRYPTION_KEY 后重启服务。"
    class="notice"
  />
  <UAlert
    v-if="settingsSaved"
    color="success"
    variant="soft"
    description="个人设置已保存，下一次录音或分析时生效。"
    class="notice"
  />

  <form class="personal-settings" @submit.prevent="emit('save', { ...form }, true)">
    <section class="settings-card">
      <div class="settings-heading">
        <div>
          <span class="eyebrow">01 / TRANSCRIPTION</span>
          <h2>百炼 · 实时转写</h2>
        </div>
        <UBadge :color="config.asr ? 'success' : 'neutral'" variant="soft">
          {{ config.asr ? '已保存个人密钥' : '未配置' }}
        </UBadge>
      </div>

      <UFormField label="百炼 API Key">
        <UInput
          v-model="form.aliyunKey"
          :type="showAliyunKey ? 'text' : 'password'"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          class="full"
          :placeholder="config.asr ? '已保存，留空保留；填写新密钥可替换' : '填写你自己的百炼 API Key'"
          maxlength="512"
        >
          <template #trailing>
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              :icon="showAliyunKey ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              :aria-label="showAliyunKey ? '隐藏百炼密钥' : '显示百炼密钥'"
              @click="showAliyunKey = !showAliyunKey"
            />
          </template>
        </UInput>
      </UFormField>

      <UFormField label="百炼 API Host">
        <UInput v-model="form.aliyunHost" class="full" placeholder="如 dashscope.aliyuncs.com" required />
        <div class="preset-row">
          <button
            v-for="preset in aliyunHostPresets"
            :key="preset.value"
            type="button"
            class="preset-chip"
            :class="{ active: form.aliyunHost === preset.value }"
            @click="form.aliyunHost = preset.value"
          >
            {{ preset.label }}
          </button>
        </div>
      </UFormField>

      <UFormField label="识别模型">
        <USelect v-model="form.aliyunModel" :items="aliyunModels" class="full" />
      </UFormField>

      <UCheckbox v-if="config.asr" v-model="form.clearAliyun" label="保存时移除已存的百炼密钥" />

      <div class="settings-card-footer">
        <div class="settings-test-row">
          <p class="muted">
            密钥与 API Host 需来自同一地域和业务空间；在线转写会将麦克风音频发送至你配置的百炼服务。
          </p>
          <UButton
            type="button"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-plug-zap"
            :loading="testingAsr"
            :disabled="!canTestAsr || busy"
            @click="runTestAsr"
          >
            测试连接
          </UButton>
        </div>
        <UAlert
          v-if="asrTestResult"
          :color="asrTestResult.ok ? 'success' : 'error'"
          variant="soft"
          :description="
            asrTestResult.latencyMs !== undefined
              ? `${asrTestResult.message}（${asrTestResult.latencyMs} ms）`
              : asrTestResult.message
          "
        />
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-heading">
        <div>
          <span class="eyebrow">02 / MEETING INSIGHTS</span>
          <h2>DeepSeek · AI 分析</h2>
        </div>
        <UBadge :color="config.ai ? 'success' : 'neutral'" variant="soft">
          {{ config.ai ? '已保存个人密钥' : '未配置' }}
        </UBadge>
      </div>

      <UFormField label="DeepSeek API Key">
        <UInput
          v-model="form.deepseekKey"
          :type="showDeepseekKey ? 'text' : 'password'"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          class="full"
          :placeholder="config.ai ? '已保存，留空保留；填写新密钥可替换' : '填写你自己的 DeepSeek API Key'"
          maxlength="512"
        >
          <template #trailing>
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              :icon="showDeepseekKey ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              :aria-label="showDeepseekKey ? '隐藏 DeepSeek 密钥' : '显示 DeepSeek 密钥'"
              @click="showDeepseekKey = !showDeepseekKey"
            />
          </template>
        </UInput>
      </UFormField>

      <UFormField label="分析模型">
        <UInput v-model="form.deepseekModel" class="full" required maxlength="100" />
        <div class="preset-row">
          <button
            v-for="preset in deepseekModelPresets"
            :key="preset"
            type="button"
            class="preset-chip"
            :class="{ active: form.deepseekModel === preset }"
            @click="form.deepseekModel = preset"
          >
            {{ preset }}
          </button>
        </div>
      </UFormField>

      <UCheckbox v-if="config.ai" v-model="form.clearDeepseek" label="保存时移除已存的 DeepSeek 密钥" />

      <div class="settings-card-footer">
        <div class="settings-test-row">
          <p class="muted">AI 分析仅发送确认转写文字，不发送原始音频；测试会向模型发送极短校验请求。</p>
          <UButton
            type="button"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-plug-zap"
            :loading="testingAi"
            :disabled="!canTestAi || busy"
            @click="runTestAi"
          >
            测试连接
          </UButton>
        </div>
        <UAlert
          v-if="aiTestResult"
          :color="aiTestResult.ok ? 'success' : 'error'"
          variant="soft"
          :description="
            aiTestResult.latencyMs !== undefined
              ? `${aiTestResult.message}（${aiTestResult.latencyMs} ms）`
              : aiTestResult.message
          "
        />
      </div>
    </section>

    <div class="settings-footer">
      <p>
        密钥加密保存，保存后不回显；通过当前浏览器的独立标识访问。<br />
        请求经服务端转发，调用模型时会解密使用。
      </p>
      <UButton type="button" color="neutral" variant="ghost" @click="emit('skip')">
        {{ config.asr || config.ai ? '返回工作台' : '先进入工作台，仅录音' }}
      </UButton>
      <UButton
        type="button"
        :color="config.encryptionReady ? 'primary' : 'neutral'"
        variant="soft"
        :loading="busy"
        :disabled="!config.encryptionReady"
        @click="emit('save', { ...form }, false)"
      >
        保存设置
      </UButton>
      <UButton
        type="submit"
        :color="config.encryptionReady ? 'primary' : 'neutral'"
        :loading="busy"
        :disabled="!config.encryptionReady"
      >
        保存并进入工作台
      </UButton>
    </div>
  </form>
</template>
