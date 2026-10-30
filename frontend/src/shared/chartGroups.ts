import { connect, disconnect } from 'echarts/core';
const members = new Map<string, number>();
export function joinChartGroup(group: string) {
  if (!group) return;
  members.set(group, (members.get(group) || 0) + 1);
  connect(group);
}
export function leaveChartGroup(group: string) {
  if (!group) return;
  const count = (members.get(group) || 0) - 1;
  if (count > 0) members.set(group, count);
  else {
    members.delete(group);
    disconnect(group);
  }
}
