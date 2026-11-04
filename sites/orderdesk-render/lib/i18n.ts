export type Language = 'zh' | 'en';

export const chineseToEnglish: Record<string, string> = {
 '导入生产数据':'Import production data','生产数据':'Production data','生产状态已重新计算':'Production status recalculated','个变更':'changes','按 PGI、Dispatch Special、Regent 和 Longtree 原始记录自动计算生产状态；请填写这份数据的更新日期。':'Calculate production status from PGI, Dispatch Special, Regent and Longtree records. Enter the update date of this data.',
 '展开导航':'Expand navigation','收起导航':'Collapse navigation',
 '新订单':'New orders','订单变更':'Order changes','已取消':'Cancelled','已完成':'Completed','签字逾期':'Sign-off overdue','已签字':'Signed off','等待签字':'Awaiting sign-off','等待发图':'Awaiting plans',
 '无法读取订单':'Unable to load orders','连接失败':'Connection failed','状态':'Status','等待天数':'Waiting days','天':'days',
 'Excel 文件不能超过 10 MB':'Excel files must be 10 MB or smaller','请选择 .xlsx 或 .xlsm 文件':'Choose an .xlsx or .xlsm file','Excel 没有工作表':'The workbook has no worksheets','文件读取失败':'Unable to read the file','导入失败':'Import failed','这份报告已经处理，无重复更新':'This report has already been processed. No duplicate updates.','导出失败':'Export failed',
 '每日总览':'Daily overview','全部订单':'All orders','变更日志':'Change log','导入记录':'Import history','订单总览':'Order overview','数据连接':'Connections','在排订单':'Active orders','取消订单':'Cancelled orders','逾期未签字':'Overdue sign-offs','已签字订单':'Signed orders','已完成订单':'Completed orders',
 '邮件自动同步未开启':'Email sync off','正在导出':'Exporting…','导出 Excel':'Export Excel','正在读取':'Reading…','导入报告':'Import report','关闭错误':'Dismiss error','关闭通知':'Dismiss notification','查看日期':'View date','今天':'Today','报告日期':'Report date','刷新订单':'Refresh orders','当前签字逾期':'Overdue sign-offs','待跟进':'Follow up','查看明细':'View details','在排':'Active',
 '搜索 Chassis、客户、型号…':'Search chassis, customer, model…','搜索订单':'Search orders','清除搜索':'Clear search','筛选 Dealer':'Filter dealer','全部 Dealer':'All dealers','重置':'Reset','没有符合条件的订单':'No matching orders',
 '页':'Page','更多':'More','每页':'Page size','下一页':'Next','上一页':'Previous','首页':'First','末页':'Last','正在读取订单…':'Loading orders…',
 '全部历史':'All history','当日变更':'Daily changes','当日':'Selected day','搜索日志':'Search history','搜索 Chassis、客户、Dealer…':'Search chassis, customer, dealer…','日志 Dealer':'History dealer','初始对账':'Initial reconciliation','没有变更记录':'No changes recorded','处理记录':'Processed reports','日报导入':'Daily report import','条源记录':'source rows','新增':'New','变更':'Changed','取消':'Cancel','待核对':'Needs review','已处理':'Processed','尚无导入记录':'No imports yet',
 '订单数据库':'Order database','已连接':'Connected','等待连接':'Awaiting connection','存储':'Storage','数据保护':'Data protection','加密存储 · 私人访问':'Encrypted storage · Private access','订单':'Orders','最新报告':'Latest report','刷新数据':'Refresh data','Outlook 报告':'Outlook reports','自动同步未开启':'Automatic sync is off','邮箱':'Mailbox','文件夹':'Folder','邮箱授权':'Mailbox access','待验证':'Not verified','云端定时任务':'Cloud schedule','待配置':'Not configured','手动导入报告':'Import report manually','Firebase 已连接':'Firebase connected','等待数据连接':'Waiting for data connection',
 '导入 CRM 报告':'Import CRM report','关闭导入':'Close import','条记录':'records','正在更新…':'Updating…','确认导入':'Confirm import','关闭明细':'Close details','订单进度':'Order progress','变更历史':'Change history','初始排程订单':'Imported from the initial schedule',
 '请先登录':'Please sign in','请求来源无效':'Invalid request origin','文件过大':'File too large','报告无有效记录':'The report contains no valid records','报告字段无效':'Invalid report fields','请先导入初始订单':'Import the initial orders first','报告日期早于已处理报告':'The report is older than the latest processed report','报告日期不能晚于今天':'The report date cannot be in the future','订单数据尚未导入':'Order data has not been imported','读取失败':'Unable to read data','未找到 CRM 报告表头':'CRM report headers were not found','报告记录数量无效':'Invalid report record count','数据库内容无效':'Invalid database content','数据库密钥未配置':'Database key is not configured','数据库读取失败':'Unable to read the database','数据已被更新，请刷新后重试':'Data has changed. Refresh and try again.','数据库保存失败':'Unable to save the database','服务配置未完成':'Service setup is incomplete',
 '车架号':'Chassis','经销商':'Dealer','年款':'Model Year','型号':'Model','客户':'Customer','需求日期':'Request Date','发图给经销商':'Plans Sent to Dealer','收到签字图纸':'Signed Plans Received','采购订单已发送':'Purchase Order Sent','预计生产日期':'Forecast Production','收到订单':'Order Received','发送至 Longtree':'Sent to Longtree','发运':'Shipment','生产状态':'Production Status','价格版本':'Price Version','日期':'Date','类型':'Type','字段':'Field','变更前':'Before','变更后':'After','批次':'Batch','创建订单':'Created','每日报告':'Daily report','计划团队':'Planning Team','排程':'Planning','订单管理':'ORDER MANAGEMENT','订单明细':'ORDER DETAILS',
 '筛选…':'Filter…','包含':'Contains','不包含':'Does not contain','等于':'Equals','不等于':'Does not equal','开头为':'Begins with','结尾为':'Ends with','空白':'Blank','非空':'Not blank','并且':'AND','或者':'OR','应用':'Apply','清除':'Clear','升序':'Sort Ascending','降序':'Sort Descending','取消排序':'Clear Sort','固定列':'Pin Column','固定在左侧':'Pin Left','固定在右侧':'Pin Right','取消固定':'No Pin','自动调整此列':'Autosize This Column','自动调整所有列':'Autosize All Columns','重置列':'Reset Columns','选择全部':'Select All','搜索…':'Search…',
};

const englishToChinese = Object.fromEntries(Object.entries(chineseToEnglish).map(([zh,en])=>[en,zh]));
Object.assign(englishToChinese, {'Status':'状态','Waiting Days':'等待天数','Change Log':'变更日志','Initial reconciliation':'初始对账','Order':'订单','Request date':'需求日期','Order Received Date':'收到订单','Order Sent to Longtree':'发送至 Longtree','PLANNING':'排程','active':'在排','cancelled':'已取消','completed':'已完成'});

export function translate(text:string,language:Language):string {
 const trimmed=text.trim();
 const dictionary=language==='en'?chineseToEnglish:englishToChinese;
 if(dictionary[trimmed])return text.replace(trimmed,dictionary[trimmed]);
 if(language==='en'&&trimmed.startsWith('初始对账 ·'))return text.replace('初始对账','Initial reconciliation');
 if(language==='en'&&trimmed.startsWith('数据库保存失败'))return text.replace('数据库保存失败','Unable to save the database');
 return text;
}

export const gridChinese:Record<string,string> = {
 page:'页',of:'/',to:'–',more:'更多',pageSizeSelectorLabel:'每页',nextPage:'下一页',previousPage:'上一页',firstPage:'首页',lastPage:'末页',loadingOoo:'正在读取订单…',noRowsToShow:'没有符合条件的订单',
 filterOoo:'筛选…',equals:'等于',notEqual:'不等于',contains:'包含',notContains:'不包含',startsWith:'开头为',endsWith:'结尾为',blank:'空白',notBlank:'非空',andCondition:'并且',orCondition:'或者',applyFilter:'应用',resetFilter:'重置',clearFilter:'清除',cancelFilter:'取消',
 lessThan:'小于',greaterThan:'大于',lessThanOrEqual:'小于或等于',greaterThanOrEqual:'大于或等于',inRange:'范围',inRangeStart:'起始',inRangeEnd:'结束',dateFormatOoo:'年-月-日',before:'早于',after:'晚于',
 sortAscending:'升序',sortDescending:'降序',sortUnSort:'取消排序',pinColumn:'固定列',pinLeft:'固定在左侧',pinRight:'固定在右侧',noPin:'取消固定',autosizeThiscolumn:'自动调整此列',autosizeAllColumns:'自动调整所有列',resetColumns:'重置列',columns:'列',searchOoo:'搜索…',selectAll:'选择全部',blanks:'空白',
 ariaColumnFilter:'列筛选',ariaColumnMenu:'列菜单',ariaPageSizeSelectorLabel:'每页记录数',ariaPageSizeSelector:'每页记录数',ariaPageNumber:'页码',ariaFirstPage:'首页',ariaLastPage:'末页',ariaNextPage:'下一页',ariaPreviousPage:'上一页',
};
