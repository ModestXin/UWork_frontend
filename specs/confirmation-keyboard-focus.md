# 确认框的键盘焦点语义

共享 `ConfirmDialogHost` 负责界面事件，`confirmDialogStore` 是唯一待确认请求与 Promise 结算所有者。业务调用者只消费原 boolean/choice 结果，不新增状态或服务接口。

在普通确认框和带复选框的确认框中，焦点位于按钮或输入控件时，Enter 必须保留原控件的浏览器语义。尤其焦点位于取消按钮时，Enter 应结算取消，不能被 window capture 监听改成确认。非控件焦点仍保留现有 Enter 确认快捷方式；Escape、遮罩和鼠标确认路径不变。

事件顺序：键盘 Enter → 已聚焦原按钮的默认 click → 原按钮回调 → store 一次结算 → 调用者决定是否发出删除命令。取消不得调用删除服务，后台推理与账本不得增加。

真实回归使用仓库未打包共享 UI、原 Host/CLI、隔离任务和真实数据库：先归档 → 删除对话框 → Shift+Tab 聚焦取消 → Enter → deleted=0、CLI 历史不变；再次打开 → 确认 → deleted=1 → reload 不复活。2026-10-21 修复前 v4 在实际取消焦点上复现 deleted=1；证据在后端仓库 `evidence/client-native-prepublish-v4-20261021`。
