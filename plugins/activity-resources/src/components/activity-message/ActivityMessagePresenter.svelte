<!--
// Copyright © 2023 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { DisplayActivityMessage, ActivityMessageViewType, ActivityMessage } from '@hcengineering/activity'
  import view from '@hcengineering/view'
  import { getClient } from '@hcengineering/presentation'
  import { Action, Component } from '@hcengineering/ui'
  import { Class, Doc, Ref } from '@hcengineering/core'

  export let value: DisplayActivityMessage
  export let doc: Doc | undefined = undefined
  export let showNotify: boolean = false
  export let isHighlighted: boolean = false
  export let isSelected: boolean = false
  export let shouldScroll: boolean = false
  export let embedded: boolean = false
  export let withActions: boolean = true
  export let showEmbedded = false
  export let hideFooter = false
  export let skipLabel = false
  export let actions: Action[] = []
  export let hoverable = true
  export let hoverStyles: 'filledHover' = 'filledHover'
  export let withShowMore: boolean = false
  export let attachmentImageSize: 'x-large' | undefined = undefined
  export let type: ActivityMessageViewType = 'default'
  export let videoPreload = false
  export let hideLink = false
  export let compact = false
  export let readonly = false
  export let onClick: (() => void) | undefined = undefined
  export let onReply: ((message: ActivityMessage) => void) | undefined = undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: objectPresenter = hierarchy.classHierarchyMixin(value._class as Ref<Class<Doc>>, view.mixin.ObjectPresenter)
</script>

{#if objectPresenter}
  <Component
    is={objectPresenter.presenter}
    props={{
      space: value.space,
      value,
      doc,
      showNotify,
      skipLabel,
      isHighlighted,
      isSelected,
      shouldScroll,
      embedded,
      withActions,
      showEmbedded,
      hideFooter,
      actions,
      hoverable,
      hoverStyles,
      withShowMore,
      attachmentImageSize,
      videoPreload,
      hideLink,
      type,
      compact,
      readonly,
      onClick,
      onReply
    }}
  />
{/if}
