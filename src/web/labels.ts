import type { TaskStatus } from '../shared/contracts.js';
export const states:Record<TaskStatus,string>={queued:'排队中',running:'执行中',paused:'已暂停',failed:'执行失败',completed:'已完成',cancelled:'已取消'};
export const reasons:Record<string,string>={auth_required:'需要登录订阅',unverified:'订阅连接待验证',quota:'额度暂不可用',input_limit:'材料超过本次范围',request_limit:'已达到请求次数上限',timeout:'已达到执行时限',interrupted:'上次执行被中断',execution_failed:'执行未成功，请检查连接后重试',cancelled:'用户已取消',recording_failed:'记录保存失败，执行已停止'};
export const time=(iso:string)=>new Date(iso).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
