# git上手指南
## 一、安装与配置 
1. 在官网安装下载git，根据自己电脑的系统配置选择适合的版本。
2. 安装完成后打开终端（windows上可以用PowerShell），输入git --version，若输出 git version 2.x.x 即为安装成功。
3. 进行身份配置：输入“git config --global user.name "你的中文名或英文名"”和“git config --global user.email "你的邮箱@example.com"”
4. 需要注意的是：
   1.--global 作用于当前系统用户（最常用）
   2.--system 作用于整台电脑所有用户（很少用）
   3.--local  作用于当前项目（仅在某个仓库内生效）
   4.当输入git config --list --show-origin时（能看见每个配置来自哪个文件）
## 二、所需代码
1. git clone https://github.com/用户/仓库.git。而且默认克隆到以仓库名命名的文件夹里。如果想指定文件夹名则输入git clone https://... 我的项目。
2. 以下方式使用commit都是可以的：
   git commit -m "修复了用户登录的 Bug"           
   git commit -m '修复了用户登录的 Bug'           
   git commit -m "她说：'没问题'"                
   git commit -m '她说："没问题"'      
3. 使用push：git push <远程仓库名> <本地分支名>:<远程分支名>
   其中：
   第一次推送，将本地 main 推到远程 main 对应：	git push -u origin main
   推送本地 feature 到远程同名分支 对应： git push origin feature
   推送本地 feature 到远程的 develop 分支 对应：	git push origin feature:develop
4. branch：
   输入git branch 会查看当前所有分支，
   输入git branch <新分支名> 会创建新分支（但不会切换过去，你仍停留在当前分支）
   输入git switch <分支名>，会切换到指定分支
   git branch -d <分支名>：删除本地分支（安全删除）。如果该分支还没合并到主分支，Git 会报错阻止你，防止代码丢失。
5. 点击GitHub仓库中的pull request就可实现合并请求功能