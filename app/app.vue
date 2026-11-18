<script setup lang="ts">
const {
  ready,
  view,
  meetings,
  selected,
  error,
  busy,
  device,
  devices,
  config,
  analyzing,
  analyzingMode,
  streaming,
  follow,
  settingsSaved,
  active,
  capturing,
  pending,
  pendingSeconds,
  volume,
  elapsed,
  initializeWorkspace,
  refreshList,
  showSettings,
  saveSettings,
  testProviderConfig,
  openMeeting,
  startNewRecording,
  loadMicrophones,
  record,
  pause,
  retryUpload,
  finish,
  toggleAutoAnalyze,
  analyzeMeeting
} = useWorkspace()

const pageTitle = computed(() =>
  view.value === 'history' ? '会议记录' : view.value === 'settings' ? '个人设置' : '会议工作台'
)

const navItems = computed(() => [
  {
    label: '会议工作台',
    icon: 'i-lucide-layout-dashboard',
    active: view.value === 'workspace',
    onSelect: () => {
      view.value = 'workspace'
    }
  },
  {
    label: '会议记录',
    icon: 'i-lucide-history',
    badge: meetings.value.length,
    disabled: active.value,
    active: view.value === 'history',
    onSelect: () => {
      view.value = 'history'
      void refreshList()
    }
  },
  {
    label: '个人设置',
    icon: 'i-lucide-settings-2',
    disabled: active.value || analyzing.value,
    active: view.value === 'settings',
    onSelect: () => {
      void showSettings()
    }
  }
])
</script>

<template>
  <UApp>
    <UDashboardGroup class="shell" storage="local" storage-key="meetnote-dashboard">
      <UDashboardSidebar class="sidebar" :toggle="false" :default-size="17" :min-size="14" :max-size="20">
        <template #header>
          <div class="brand">
            <span class="brand-symbol"><UIcon name="i-lucide-audio-lines" /></span>
            <span>MeetNote</span>
          </div>
        </template>
        <template #default>
          <p class="nav-label">工作空间</p>
          <UNavigationMenu
            :items="navItems"
            orientation="vertical"
            color="primary"
            variant="pill"
            highlight
            highlight-color="primary"
            class="workspace-nav"
            :ui="{ list: 'gap-1', link: 'rounded-lg px-3 py-2.5', linkLeadingIcon: 'size-4' }"
          />
          <div class="recent-heading">
            <p class="nav-label">最近会议</p>
            <UBadge color="neutral" variant="subtle" size="xs">{{ meetings.length }}</UBadge>
          </div>
          <div v-if="meetings.length" class="recent-list">
            <UButton
              v-for="meeting in meetings.slice(0, 6)"
              :key="meeting.id"
              color="neutral"
              variant="ghost"
              size="sm"
              block
              class="recent-item"
              :class="{ 'recent-active': selected?.id === meeting.id }"
              @click="openMeeting(meeting.id)"
            >
              <span class="recent-dot" :class="{ live: meeting.status === 'recording' }" />
              <span class="recent-title">{{ meeting.title }}</span>
            </UButton>
          </div>
          <p v-else class="sidebar-empty">录音完成后会显示在这里。</p>
        </template>
      </UDashboardSidebar>

      <UDashboardPanel class="main">
        <template #header>
          <UDashboardNavbar :title="pageTitle" class="topbar">
            <template #right>
              <UBadge :color="ready ? 'success' : error ? 'error' : 'neutral'" variant="subtle" class="server-state">
                <span class="server-dot" /> {{ ready ? '服务已连接' : error ? '连接异常' : '正在连接…' }}
              </UBadge>
            </template>
          </UDashboardNavbar>
        </template>

        <template #body>
          <div class="content">
            <UAlert
              v-if="error"
              color="error"
              variant="soft"
              :description="error"
              class="notice"
              close
              @update:open="error = ''"
            />
            <div v-if="!ready" class="empty-history">
              正在准备工作台…
              <UButton v-if="error" :loading="busy" @click="initializeWorkspace">重试</UButton>
            </div>

            <template v-else-if="view === 'workspace'">
              <div class="page-heading">
                <div>
                  <span class="eyebrow">MEETING STUDIO</span>
                  <h1>{{ selected ? selected.title : '让每次讨论，都有记录。' }}</h1>
                  <p class="muted">
                    {{
                      selected
                        ? `${formatDate(selected.created)} · ${MEETING_STATUS_LABEL[selected.status]}`
                        : '准备好后直接开始录音，转写自动保存，需要时可手动总结。'
                    }}
                  </p>
                </div>
                <UButton v-if="selected && !active && !analyzing" icon="i-lucide-mic" @click="startNewRecording">
                  开始新录音
                </UButton>
              </div>

              <WorkspaceLaunch
                v-if="!selected"
                :config="config"
                :busy="busy"
                :analyzing="analyzing"
                @start="startNewRecording"
              />

              <MeetingStudio
                v-else
                v-model:device="device"
                v-model:follow="follow"
                :selected="selected"
                :config="config"
                :busy="busy"
                :analyzing="analyzing"
                :analyzing-mode="analyzingMode"
                :streaming="streaming"
                :active="active"
                :capturing="capturing"
                :pending="pending"
                :pending-seconds="pendingSeconds"
                :volume="volume"
                :elapsed="elapsed"
                :devices="devices"
                @load-microphones="loadMicrophones"
                @record="record"
                @pause="pause"
                @retry="retryUpload"
                @finish="finish"
                @toggle-auto-analyze="toggleAutoAnalyze"
                @analyze="analyzeMeeting"
              />
            </template>

            <MeetingHistory
              v-else-if="view === 'history'"
              :meetings="meetings"
              :busy="busy"
              @start-new="startNewRecording"
              @open="openMeeting"
            />

            <SettingsForm
              v-else-if="view === 'settings'"
              :config="config"
              :settings-saved="settingsSaved"
              :busy="busy"
              :test-connection="testProviderConfig"
              @save="saveSettings"
              @skip="view = 'workspace'"
            />
          </div>
        </template>
      </UDashboardPanel>
    </UDashboardGroup>
  </UApp>
</template>
