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
  export let element: HTMLDivElement | undefined | null = undefined
</script>

<div class="w-full text-sm flex-center whitespace-nowrap container" bind:this={element}>
  <div class="line mr-3" />
</div>

<style lang="scss">
  .container {
    padding: 0 4rem;
  }

  .line {
    position: relative;
    width: 100%;
    height: 1px;
    border-top: 1px dashed var(--global-higlight-Color);
  }
</style>
