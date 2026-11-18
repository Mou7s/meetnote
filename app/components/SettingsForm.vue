<script setup lang="ts">
import type { UserConfig } from '../../shared/types'
import type { PersonalSettingsPayload } from '../composables/useWorkspace'

const props = defineProps<{
  config: UserConfig
  settingsSaved: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  save: [payload: PersonalSettingsPayload]
  skip: []
}>()

const form = reactive<PersonalSettingsPayload>({
  aliyunKey: '',
  deepseekKey: '',
  clearAliyun: false,
  clearDeepseek: false,
  aliyunHost: props.config.aliyunHost,
  aliyunModel: props.config.aliyunModel,
  deepseekModel: props.config.deepseekModel
})

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
    v-if="settingsSaved"
    color="success"
    variant="soft"
    description="个人设置已保存，下一次录音或分析时生效。"
    class="notice"
  />
  <form class="personal-settings" @submit.prevent="emit('save', { ...form })">
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
          type="text"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          class="full"
          :placeholder="config.asr ? '已保存，留空保留；填写新密钥可替换' : '填写你自己的百炼 API Key'"
          maxlength="512"
        />
      </UFormField>
      <UFormField label="百炼 API Host">
        <UInput v-model="form.aliyunHost" class="full" placeholder="填写百炼创建密钥时显示的 API Host" required />
      </UFormField>
      <UFormField label="识别模型">
        <select v-model="form.aliyunModel" class="full">
          <option value="qwen-audio-3.1-asr-flash-streaming">qwen-audio-3.1-asr-flash-streaming</option>
          <option value="fun-asr-realtime">fun-asr-realtime</option>
          <option value="paraformer-realtime-v2">paraformer-realtime-v2</option>
        </select>
      </UFormField>
      <UCheckbox v-if="config.asr" v-model="form.clearAliyun" label="保存时移除已存的百炼密钥" />
      <p class="muted">
        密钥与 API Host 必须来自同一地域和业务空间；新加坡可使用 dashscope-intl.aliyuncs.com 或对应的业务空间 Host。在线转写会将麦克风音频发送至你配置的百炼服务。
      </p>
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
          type="text"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          class="full"
          :placeholder="config.ai ? '已保存，留空保留；填写新密钥可替换' : '填写你自己的 DeepSeek API Key'"
          maxlength="512"
        />
      </UFormField>
      <UFormField label="分析模型">
        <UInput v-model="form.deepseekModel" class="full" required maxlength="100" />
      </UFormField>
      <UCheckbox v-if="config.ai" v-model="form.clearDeepseek" label="保存时移除已存的 DeepSeek 密钥" />
      <p class="muted">AI 分析发送确认转写文字，不发送原始音频。</p>
    </section>

    <div class="settings-footer">
      <p>
        密钥加密保存，保存后不回显；通过当前浏览器的独立标识访问。<br />
        请求经本站服务端转发，站点服务在调用时会解密使用。
      </p>
      <UButton type="submit" size="lg" :loading="busy">保存并进入工作台</UButton>
      <UButton color="neutral" variant="ghost" @click="emit('skip')">先进入工作台，仅录音</UButton>
    </div>
  </form>
</template>
