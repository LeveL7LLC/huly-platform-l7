<!--
// Copyright © 2025 Hardcore Engineering Inc.
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
  import { Context, Process, SelectedContext } from '@hcengineering/process'
  import { Label } from '@hcengineering/ui'
  import plugin from '../../plugin'
  import AttrContextPresenter from './AttrContextPresenter.svelte'
  import NestedContextPresenter from './NestedContextPresenter.svelte'
  import RelContextPresenter from './RelContextPresenter.svelte'
  import FunctionContextPresenter from './FunctionContextPresenter.svelte'
  import ExecutionContextPresenter from './ExecutionContextPresenter.svelte'

  export let process: Process
  export let contextValue: SelectedContext
  export let context: Context
</script>

<div class="container flex-row-center">
  {#if contextValue.type === 'attribute'}
    <AttrContextPresenter {contextValue} {context} />
  {:else if contextValue.type === 'relation'}
    <RelContextPresenter {contextValue} {context} />
  {:else if contextValue.type === 'nested'}
    <NestedContextPresenter {contextValue} {context} />
  {:else if contextValue.type === 'userRequest'}
    <Label label={plugin.string.RequestFromUser} />
  {:else if contextValue.type === 'function'}
    <FunctionContextPresenter {contextValue} {context} />
  {:else if contextValue.type === 'context'}
    <ExecutionContextPresenter {contextValue} {process} />
  {/if}
</div>

<style lang="scss">
  .container {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--theme-caption-color);
  }
</style>
