/**
 * @author fmz200，Baby (修复版 by Claude)
 * @function 小红书去广告、净化、解除下载限制、画质增强等
 * @date 2025-12-18 修复版
 * @fixes 
 *   - 修复图片缓存覆盖问题（改用note_id索引）
 *   - 修复只处理第一张图片的bug
 *   - 增强空值检查，防止崩溃
 *   - 优化Live Photo匹配逻辑
 *   - 改进日志输出
 */

const $ = new Env('小红书');
const url = $request.url;
let rsp_body = $response.body;

if (!rsp_body) {
  console.log('⚠️ 响应体为空，跳过处理');
  $done({});
}

let obj;
try {
  obj = JSON.parse(rsp_body);
} catch (e) {
  console.error('❌ JSON解析失败: ' + e);
  $done({body: rsp_body});
}

// ================== 搜索相关净化 ==================
if (url.includes("/search/banner_list")) {
  console.log('🧹 清除搜索横幅');
  obj.data = {};
}

if (url.includes("/search/hot_list")) {
  console.log('🧹 清除热搜列表');
  obj.data.items = [];
}

if (url.includes("/search/hint")) {
  console.log('🧹 清除搜索栏填充词');
  obj.data.hint_words = [];
}

if (url.includes("/search/trending?")) {
  console.log('🧹 清除搜索栏推荐');
  obj.data.queries = [];
  obj.data.hint_word = {};
}

if (url.includes("/search/notes?")) {
  if (obj.data?.items?.length > 0) {
    const originalCount = obj.data.items.length;
    obj.data.items = obj.data.items.filter((i) => i.model_type === "note");
    console.log(`🧹 过滤搜索结果: ${originalCount} → ${obj.data.items.length}`);
  }
}

// ================== 系统配置 ==================
if (url.includes("/system_service/config?")) {
  const item = ["app_theme", "loading_img", "splash", "store"];
  if (obj.data) {
    for (let i of item) {
      delete obj.data[i];
    }
    console.log('🧹 清除系统配置广告');
  }
}

if (url.includes("/system_service/splash_config")) {
  if (obj?.data?.ads_groups?.length > 0) {
    for (let i of obj.data.ads_groups) {
      i.start_time = 3818332800;
      i.end_time = 3818419199;
      if (i?.ads?.length > 0) {
        for (let ii of i.ads) {
          ii.start_time = 3818332800;
          ii.end_time = 3818419199;
        }
      }
    }
    console.log('🧹 处理开屏广告（设置未来时间）');
  }
}

// ================== 图片信息流 - 核心修复 ==================
if (url.includes("/note/imagefeed?") || url.includes("/note/feed?")) {
  console.log('📸 处理图片信息流');
  
  if (!obj?.data?.[0]?.note_list) {
    console.log('⚠️ 数据结构异常，跳过处理');
    $done({body: rsp_body});
  }
  
  // 读取现有缓存
  let imageCache = {};
  try {
    const cacheStr = $.getdata("fmz200.xiaohongshu.image.cache");
    if (cacheStr) {
      imageCache = JSON.parse(cacheStr);
    }
  } catch (e) {
    console.log('⚠️ 读取缓存失败，使用空缓存');
  }
  
  let processedCount = 0;
  
  for (let item of obj.data[0].note_list) {
    if (!item) continue;
    
    try {
      // 1. 解除下载限制
      if (item?.media_save_config) {
        item.media_save_config.disable_save = false;
        item.media_save_config.disable_watermark = true;
        item.media_save_config.disable_weibo_cover = true;
      }
      
      // 2. 添加下载按钮
      if (item?.share_info?.function_entries?.length > 0) {
        const hasDownload = item.share_info.function_entries.some(
          entry => entry.type === "video_download"
        );
        if (!hasDownload) {
          item.share_info.function_entries.unshift({type: "video_download"});
        }
      }
      
      // 3. 处理帖子引用的标签
      if (item.hash_tag) {
        item.hash_tag = item.hash_tag.filter(tag => tag.type !== "interact_vote");
      }
      
      // 4. 画质增强并缓存
      if (item?.images_list?.length > 0) {
        const enhanced = imageEnhance(JSON.stringify(item.images_list));
        if (enhanced) {
          item.images_list = enhanced;
          
          // 使用note_id作为key缓存
          if (item.id) {
            imageCache[item.id] = item.images_list;
            processedCount++;
          }
        }
      }
    } catch (e) {
      console.error(`❌ 处理笔记失败 [${item?.id}]: ${e}`);
    }
  }
  
  // 保存缓存（限制缓存大小，只保留最近50条）
  const cacheKeys = Object.keys(imageCache);
  if (cacheKeys.length > 50) {
    const keysToKeep = cacheKeys.slice(-50);
    const newCache = {};
    keysToKeep.forEach(key => newCache[key] = imageCache[key]);
    imageCache = newCache;
  }
  
  $.setdata(JSON.stringify(imageCache), "fmz200.xiaohongshu.image.cache");
  console.log(`✅ 处理完成：${processedCount} 条笔记已缓存`);
}

// ================== Live Photo 保存 - 修复版 ==================
if (url.includes("/note/live_photo/save")) {
  console.log('🎬 处理Live Photo保存请求');
  console.log('原始响应: ' + rsp_body.substring(0, 200));
  
  // 从URL提取file_id
  let requestFileId = null;
  try {
    const urlObj = new URL(url);
    requestFileId = urlObj.searchParams.get('file_id');
    console.log('请求的file_id: ' + requestFileId);
  } catch (e) {
    console.log('⚠️ 无法解析URL参数');
  }
  
  const cacheStr = $.getdata("fmz200.xiaohongshu.image.cache");
  if (!cacheStr) {
    console.log('❌ 缓存为空，返回原始响应');
    $done({body: rsp_body});
  }
  
  try {
    const imageCache = JSON.parse(cacheStr);
    let new_data = [];
    let foundMatch = false;
    
    // 遍历所有缓存的笔记
    for (const noteId in imageCache) {
      const images = imageCache[noteId];
      if (!Array.isArray(images)) continue;
      
      for (const image of images) {
        if (image?.live_photo_file_id) {
          // 如果有明确的file_id，进行精确匹配
          if (requestFileId && image.live_photo_file_id === requestFileId) {
            foundMatch = true;
          }
          
          // 提取Live Photo数据
          if (image.live_photo?.media?.stream?.h265?.[0]?.master_url) {
            const item = {
              file_id: image.live_photo_file_id,
              video_id: image.live_photo.media.video_id,
              url: image.live_photo.media.stream.h265[0].master_url
            };
            new_data.push(item);
            
            if (foundMatch) {
              console.log(`✅ 找到匹配: ${item.file_id}`);
              break;
            }
          }
        }
      }
      if (foundMatch) break;
    }
    
    if (new_data.length === 0) {
      console.log('⚠️ 未找到Live Photo数据，返回原响应');
      $done({body: rsp_body});
    }
    
    // 替换URL
    if (obj.data?.datas) {
      replaceUrlContent(obj.data.datas, new_data);
      console.log(`✅ 已替换 ${new_data.length} 个Live Photo链接`);
    } else {
      obj = {
        "code": 0,
        "success": true,
        "msg": "成功",
        "data": {"datas": new_data}
      };
      console.log('✅ 创建新响应结构');
    }
    
  } catch (e) {
    console.error('❌ 处理Live Photo失败: ' + e);
    $done({body: rsp_body});
  }
}

// ================== 笔记小组件 ==================
if (url.includes("/note/widgets")) {
  const item = ["cooperate_binds", "generic", "note_next_step", "widget_list"];
  if (obj?.data) {
    for (let i of item) {
      delete obj.data[i];
    }
    console.log('🧹 清除笔记小组件');
  }
}

// ================== 视频信息流 V3 ==================
if (url.includes("/v3/note/videofeed?")) {
  console.log('🎥 处理视频信息流 V3');
  
  if (obj?.data?.length > 0) {
    let processedCount = 0;
    
    for (let item of obj.data) {
      if (!item) continue;
      
      if (item?.media_save_config) {
        item.media_save_config.disable_save = false;
        item.media_save_config.disable_watermark = true;
        item.media_save_config.disable_weibo_cover = true;
      }
      
      if (item?.share_info?.function_entries?.length > 0) {
        const hasDownload = item.share_info.function_entries.some(
          entry => entry.type === "video_download"
        );
        if (!hasDownload) {
          item.share_info.function_entries.unshift({type: "video_download"});
          processedCount++;
        }
      }
    }
    
    console.log(`✅ 处理了 ${processedCount} 个视频`);
  }
}

// ================== 视频信息流 V4 - 修复版 ==================
if (url.includes("/v4/note/videofeed")) {
  console.log('🎥 处理视频信息流 V4');
  
  let videoData = [];
  
  if (obj.data?.length > 0) {
    for (let item of obj.data) {
      if (!item) continue;
      
      try {
        // 1. 强制开启权限
        if (item?.media_save_config) {
          item.media_save_config.disable_save = false;
          item.media_save_config.disable_watermark = true;
          item.media_save_config.disable_weibo_cover = true;
        }
        
        // 2. 处理 function_switch（修复按钮置灰）
        if (item?.function_switch?.length > 0) {
          for (let switchItem of item.function_switch) {
            if (switchItem.type === "video_download") {
              switchItem.enable = true;
              if (switchItem.reason) delete switchItem.reason;
            }
          }
        }
        
        // 3. 添加下载按钮
        if (item?.share_info?.function_entries?.length > 0) {
          const hasDownload = item.share_info.function_entries.some(
            entry => entry.type === "video_download"
          );
          if (!hasDownload) {
            item.share_info.function_entries.push({type: "video_download"});
          }
        }
        
        // 4. 提取最佳视频流
        const h265List = item?.video_info_v2?.media?.stream?.h265 || [];
        const h264List = item?.video_info_v2?.media?.stream?.h264 || [];
        
        let selectedStream = null;
        
        // 排序函数：优先分辨率面积，其次平均码率
        const sortStream = (a, b) => {
          const resA = (a.width || 0) * (a.height || 0);
          const resB = (b.width || 0) * (b.height || 0);
          if (resB !== resA) return resB - resA;
          return (b.avg_bitrate || 0) - (a.avg_bitrate || 0);
        };
        
        // 优先H265
        if (Array.isArray(h265List) && h265List.length > 0) {
          const sorted = h265List.filter(v => !!v.master_url).sort(sortStream);
          if (sorted.length > 0) selectedStream = sorted[0];
        }
        
        // 降级到H264
        if (!selectedStream && Array.isArray(h264List) && h264List.length > 0) {
          const sorted = h264List.filter(v => !!v.master_url).sort(sortStream);
          if (sorted.length > 0) selectedStream = sorted[0];
        }
        
        // 存入缓存数组
        if (item?.id && selectedStream?.master_url) {
          const data = {
            id: item.id,
            url: selectedStream.master_url,
            quality: selectedStream.quality_type || 'unknown',
            bitrate: selectedStream.avg_bitrate || 0
          };
          videoData.push(data);
          console.log(`✅ [${item.id}] ${selectedStream.stream_desc || 'N/A'} | ${selectedStream.quality_type || 'N/A'}`);
        } else {
          console.log(`⚠️ 未找到可用视频: ${item?.id || 'unknown'}`);
        }
        
      } catch (e) {
        console.error(`❌ 处理视频失败 [${item?.id}]: ${e}`);
      }
    }
    
    // 写入持久化缓存（限制50条）
    if (videoData.length > 50) {
      videoData = videoData.slice(-50);
    }
    
    $.setdata(JSON.stringify(videoData), "redBookVideoFeed");
    console.log(`✅ 已缓存 ${videoData.length} 条视频`);
  }
}

// ================== 视频保存请求 - 增强版 ==================
if (url.includes("/v10/note/video/save")) {
  console.log('💾 处理视频保存请求');
  
  const cacheStr = $.getdata("redBookVideoFeed");
  if (!cacheStr) {
    console.log('⚠️ 视频缓存为空');
  } else {
    try {
      const videoFeed = JSON.parse(cacheStr);
      const noteId = obj.data?.note_id;
      
      if (noteId && Array.isArray(videoFeed)) {
        const matchedVideo = videoFeed.find(item => item.id === noteId);
        
        if (matchedVideo) {
          obj.data.download_url = matchedVideo.url;
          console.log(`✅ 找到视频: ${noteId}`);
          console.log(`   画质: ${matchedVideo.quality} | 码率: ${matchedVideo.bitrate}`);
        } else {
          console.log(`⚠️ 未找到视频 ${noteId} 的缓存`);
        }
      }
    } catch (e) {
      console.error('❌ 读取视频缓存失败: ' + e);
    }
  }
  
  // 解除下载限制
  if (obj.data?.disable) {
    delete obj.data.disable;
    delete obj.data.msg;
    obj.data.status = 2;
    console.log('✅ 解除下载限制');
  }
}

// ================== 关注页信息流 ==================
if (url.includes("/user/followings/followfeed")) {
  if (obj?.data?.items?.length > 0) {
    const originalCount = obj.data.items.length;
    obj.data.items = obj.data.items.filter((i) => i?.recommend_reason === "friend_post");
    console.log(`🧹 过滤关注页: ${originalCount} → ${obj.data.items.length}`);
  }
}

if (url.includes("/v4/followfeed")) {
  if (obj?.data?.items?.length > 0) {
    const originalCount = obj.data.items.length;
    obj.data.items = obj.data.items.filter((i) => !["recommend_user"].includes(i.recommend_reason));
    console.log(`🧹 过滤关注列表: ${originalCount} → ${obj.data.items.length}`);
  }
}

if (url.includes("/recommend/user/follow_recommend")) {
  if (obj?.data?.title === "你可能感兴趣的人" && obj?.data?.rec_users?.length > 0) {
    obj.data = {};
    console.log('🧹 清除推荐用户');
  }
}

// ================== 首页信息流 ==================
if (url.includes("/v6/homefeed")) {
  if (obj?.data?.length > 0) {
    const originalCount = obj.data.length;
    let newItems = [];
    
    for (let item of obj.data) {
      if (!item) continue;
      
      // 过滤广告内容
      if (item?.model_type === "live_v2") {
        continue; // 直播
      } else if (item?.hasOwnProperty("ads_info")) {
        continue; // 赞助
      } else if (item?.hasOwnProperty("card_icon")) {
        continue; // 带货
      } else if (item?.note_attributes?.includes("goods")) {
        continue; // 商品
      } else {
        if (item?.related_ques) {
          delete item.related_ques;
        }
        newItems.push(item);
      }
    }
    
    obj.data = newItems;
    console.log(`🧹 过滤首页: ${originalCount} → ${newItems.length}`);
  }
}

// ================== 评论区 - 修复版 ==================
if (url.includes("/api/sns/v5/note/comment/list?") || url.includes("/api/sns/v3/note/comment/sub_comments?")) {
  console.log('💬 处理评论区');
  
  replaceRedIdWithFmz200(obj.data);
  let livePhotos = [];
  let note_id = "";
  
  if (obj.data?.comments?.length > 0) {
    note_id = obj.data.comments[0].note_id;
    
    for (const comment of obj.data.comments) {
      try {
        // 修复评论类型
        if (comment.comment_type === 3) {
          comment.comment_type = 2;
        }
        if (comment.media_source_type === 1) {
          comment.media_source_type = 0;
        }
        
        // 提取Live Photo
        if (comment.pictures?.length > 0) {
          for (const picture of comment.pictures) {
            if (picture.video_id && picture.video_info) {
              try {
                const picObj = JSON.parse(picture.video_info);
                if (picObj.stream?.h265?.[0]?.master_url) {
                  livePhotos.push({
                    videId: picture.video_id,
                    videoUrl: picObj.stream.h265[0].master_url
                  });
                }
              } catch (e) {
                console.log(`⚠️ 解析video_info失败: ${e}`);
              }
            }
          }
        }
        
        // 处理子评论
        if (comment.sub_comments?.length > 0) {
          for (const sub_comment of comment.sub_comments) {
            if (sub_comment.comment_type === 3) {
              sub_comment.comment_type = 2;
            }
            if (sub_comment.media_source_type === 1) {
              sub_comment.media_source_type = 0;
            }
            
            if (sub_comment.pictures?.length > 0) {
              for (const picture of sub_comment.pictures) {
                if (picture.video_id && picture.video_info) {
                  try {
                    const picObj = JSON.parse(picture.video_info);
                    if (picObj.stream?.h265?.[0]?.master_url) {
                      livePhotos.push({
                        videId: picture.video_id,
                        videoUrl: picObj.stream.h265[0].master_url
                      });
                    }
                  } catch (e) {
                    console.log(`⚠️ 解析子评论video_info失败: ${e}`);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`❌ 处理评论失败: ${e}`);
      }
    }
  }
  
  // 缓存Live Photos
  if (livePhotos.length > 0) {
    let commitsRsp;
    const commitsCache = $.getdata("fmz200.xiaohongshu.comments.rsp");
    
    if (!commitsCache) {
      commitsRsp = {noteId: note_id, livePhotos: livePhotos};
    } else {
      try {
        commitsRsp = JSON.parse(commitsCache);
        
        if (commitsRsp.noteId === note_id) {
          // 增量添加并去重
          commitsRsp.livePhotos = deduplicateLivePhotos(
            commitsRsp.livePhotos.concat(livePhotos)
          );
          console.log('📝 增量更新评论缓存');
        } else {
          // 更换笔记
          commitsRsp = {noteId: note_id, livePhotos: livePhotos};
          console.log('📝 更新评论缓存（新笔记）');
        }
      } catch (e) {
        commitsRsp = {noteId: note_id, livePhotos: livePhotos};
      }
    }
    
    $.setdata(JSON.stringify(commitsRsp), "fmz200.xiaohongshu.comments.rsp");
    console.log(`✅ 缓存了 ${livePhotos.length} 个评论Live Photo`);
  }
}

// ================== 下载评论区Live图 ==================
if (url.includes("/api/sns/v1/interaction/comment/video/download?")) {
  console.log('💾 处理评论Live图下载');
  
  const commitsCache = $.getdata("fmz200.xiaohongshu.comments.rsp");
  const targetVideoId = obj.data?.video?.video_id;
  
  if (!commitsCache) {
    console.log('⚠️ 评论缓存为空');
  } else if (!targetVideoId) {
    console.log('⚠️ 未找到video_id');
  } else {
    try {
      const commitsRsp = JSON.parse(commitsCache);
      
      if (commitsRsp.livePhotos?.length > 0) {
        const matchedVideo = commitsRsp.livePhotos.find(
          item => item.videId === targetVideoId
        );
        
        if (matchedVideo) {
          obj.data.video.video_url = matchedVideo.videoUrl;
          console.log(`✅ 替换评论视频链接: ${targetVideoId}`);
        } else {
          console.log(`⚠️ 未找到 ${targetVideoId} 的无水印地址`);
        }
      }
    } catch (e) {
      console.error('❌ 处理评论视频失败: ' + e);
    }
  }
}

$done({body: JSON.stringify(obj)});

// ================== 工具函数 ==================

// 图片画质增强（修复版）
function imageEnhance(jsonStr) {
  if (!jsonStr || jsonStr === 'undefined' || jsonStr === 'null') {
    console.error("❌ imageEnhance: 输入为空");
    return null;
  }

  const imageQuality = $.getdata("fmz200.xiaohongshu.imageQuality");
  console.log(`🎨 画质设置: ${imageQuality || '高像素（默认）'}`);
  
  try {
    if (imageQuality === "original") {
      // 原始分辨率，PNG格式
      jsonStr = jsonStr.replace(
        /\?imageView2\/2[^&"]*(?:&redImage\/frame\/0)?/g,
        "?imageView2/0/format/png&redImage/frame/0"
      );
      console.log('✅ 应用原始画质');
    } else {
      // 高像素输出（2K）
      jsonStr = jsonStr.replace(
        /(imageView2\/2\/[wh])\/\d+/g,
        "$1/2160"
      );
      console.log('✅ 应用2K画质');
    }
    
    const result = JSON.parse(jsonStr);
    
    if (!Array.isArray(result)) {
      console.error('❌ imageEnhance: 返回值不是数组');
      return null;
    }
    
    console.log(`✅ 画质增强完成，处理了 ${result.length} 张图片`);
    return result;
    
  } catch (e) {
    console.error("❌ imageEnhance 失败: ", e);
    return null;
  }
}

// 替换URL内容
function replaceUrlContent(collectionA, collectionB) {
  if (!Array.isArray(collectionA) || !Array.isArray(collectionB)) {
    console.log('⚠️ replaceUrlContent: 参数不是数组');
    return;
  }
  
  console.log(`🔄 准备替换 ${collectionA.length} 个URL`);
  let replacedCount = 0;
  
  collectionA.forEach(itemA => {
    const itemB = collectionB.find(itemB => itemB.file_id === itemA.file_id);
    if (itemB && itemB.url) {
      const urlMatch = itemB.url.match(/(.*)\.mp4/);
      if (urlMatch) {
        itemA.url = itemA.url !== "" 
          ? itemA.url.replace(/^https?:\/\/.*\.mp4(\?[^"]*)?/g, `${urlMatch[1]}.mp4`)
          : itemB.url;
        itemA.author = "@fmz200";
        replacedCount++;
      }
    }
  });
  
  console.log(`✅ 已替换 ${replacedCount} 个URL`);
}

// 去重Live Photos
function deduplicateLivePhotos(livePhotos) {
  if (!Array.isArray(livePhotos)) {
    return [];
  }
  
  const seen = new Map();
  const result = livePhotos.filter(item => {
    if (!item?.videId || seen.has(item.videId)) {
      return false;
    }
    seen.set(item.videId, true);
    return true;
  });
  
  console.log(`🔄 去重: ${livePhotos.length} → ${result.length}`);
  return result;
}

// 替换red_id为fmz200
function replaceRedIdWithFmz200(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(item => replaceRedIdWithFmz200(item));
  } else if (typeof obj === 'object' && obj !== null) {
    if ('red_id' in obj) {
      obj.fmz200 = obj.red_id;
      delete obj.red_id;
    }
    Object.keys(obj).forEach(key => {
      replaceRedIdWithFmz200(obj[key]);
    });
  }
}

function Env(t, e) { class s { constructor(t) { this.env = t } send(t, e = "GET") { t = "string" == typeof t ? { url: t } : t; let s = this.get; return "POST" === e && (s = this.post), new Promise((e, i) => { s.call(this, t, (t, s, r) => { t ? i(t) : e(s) }) }) } get(t) { return this.send.call(this.env, t) } post(t) { return this.send.call(this.env, t, "POST") } } return new class { constructor(t, e) { this.name = t, this.http = new s(this), this.data = null, this.dataFile = "box.dat", this.logs = [], this.isMute = !1, this.isNeedRewrite = !1, this.logSeparator = "\n", this.encoding = "utf-8", this.startTime = (new Date).getTime(), Object.assign(this, e), this.log("", `\ud83d\udd14${this.name}, \u5f00\u59cb!`) } isNode() { return "undefined" != typeof module && !!module.exports } isQuanX() { return "undefined" != typeof $task } isSurge() { return "undefined" != typeof $httpClient && "undefined" == typeof $loon } isLoon() { return "undefined" != typeof $loon } isShadowrocket() { return "undefined" != typeof $rocket } isStash() { return "undefined" != typeof $environment && $environment["stash-version"] } toObj(t, e = null) { try { return JSON.parse(t) } catch { return e } } toStr(t, e = null) { try { return JSON.stringify(t) } catch { return e } } getjson(t, e) { let s = e; const i = this.getdata(t); if (i) try { s = JSON.parse(this.getdata(t)) } catch { } return s } setjson(t, e) { try { return this.setdata(JSON.stringify(t), e) } catch { return !1 } } getScript(t) { return new Promise(e => { this.get({ url: t }, (t, s, i) => e(i)) }) } runScript(t, e) { return new Promise(s => { let i = this.getdata("@chavy_boxjs_userCfgs.httpapi"); i = i ? i.replace(/\n/g, "").trim() : i; let r = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout"); r = r ? 1 * r : 20, r = e && e.timeout ? e.timeout : r; const [o, a] = i.split("@"), n = { url: `http://${a}/v1/scripting/evaluate`, body: { script_text: t, mock_type: "cron", timeout: r }, headers: { "X-Key": o, Accept: "*/*" } }; this.post(n, (t, e, i) => s(i)) }).catch(t => this.logErr(t)) } loaddata() { if (!this.isNode()) return {}; { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), i = !s && this.fs.existsSync(e); if (!s && !i) return {}; { const i = s ? t : e; try { return JSON.parse(this.fs.readFileSync(i)) } catch (t) { return {} } } } } writedata() { if (this.isNode()) { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), i = !s && this.fs.existsSync(e), r = JSON.stringify(this.data); s ? this.fs.writeFileSync(t, r) : i ? this.fs.writeFileSync(e, r) : this.fs.writeFileSync(t, r) } } lodash_get(t, e, s) { const i = e.replace(/\[(\d+)\]/g, ".$1").split("."); let r = t; for (const t of i) if (r = Object(r)[t], void 0 === r) return s; return r } lodash_set(t, e, s) { return Object(t) !== t ? t : (Array.isArray(e) || (e = e.toString().match(/[^.[\]]+/g) || []), e.slice(0, -1).reduce((t, s, i) => Object(t[s]) === t[s] ? t[s] : t[s] = Math.abs(e[i + 1]) >> 0 == +e[i + 1] ? [] : {}, t)[e[e.length - 1]] = s, t) } getdata(t) { let e = this.getval(t); if (/^@/.test(t)) { const [, s, i] = /^@(.*?)\.(.*?)$/.exec(t), r = s ? this.getval(s) : ""; if (r) try { const t = JSON.parse(r); e = t ? this.lodash_get(t, i, "") : e } catch (t) { e = "" } } return e } setdata(t, e) { let s = !1; if (/^@/.test(e)) { const [, i, r] = /^@(.*?)\.(.*?)$/.exec(e), o = this.getval(i), a = i ? "null" === o ? null : o || "{}" : "{}"; try { const e = JSON.parse(a); this.lodash_set(e, r, t), s = this.setval(JSON.stringify(e), i) } catch (e) { const o = {}; this.lodash_set(o, r, t), s = this.setval(JSON.stringify(o), i) } } else s = this.setval(t, e); return s } getval(t) { return this.isSurge() || this.isLoon() ? $persistentStore.read(t) : this.isQuanX() ? $prefs.valueForKey(t) : this.isNode() ? (this.data = this.loaddata(), this.data[t]) : this.data && this.data[t] || null } setval(t, e) { return this.isSurge() || this.isLoon() ? $persistentStore.write(t, e) : this.isQuanX() ? $prefs.setValueForKey(t, e) : this.isNode() ? (this.data = this.loaddata(), this.data[e] = t, this.writedata(), !0) : this.data && this.data[e] || null } initGotEnv(t) { this.got = this.got ? this.got : require("got"), this.cktough = this.cktough ? this.cktough : require("tough-cookie"), this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar, t && (t.headers = t.headers ? t.headers : {}, void 0 === t.headers.Cookie && void 0 === t.cookieJar && (t.cookieJar = this.ckjar)) } get(t, e = (() => { })) { if (t.headers && (delete t.headers["Content-Type"], delete t.headers["Content-Length"]), this.isSurge() || this.isLoon()) this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient.get(t, (t, s, i) => { !t && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, i) }); else if (this.isQuanX()) this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then(t => { const { statusCode: s, statusCode: i, headers: r, body: o } = t; e(null, { status: s, statusCode: i, headers: r, body: o }, o) }, t => e(t && t.error || "UndefinedError")); else if (this.isNode()) { let s = require("iconv-lite"); this.initGotEnv(t), this.got(t).on("redirect", (t, e) => { try { if (t.headers["set-cookie"]) { const s = t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString(); s && this.ckjar.setCookieSync(s, null), e.cookieJar = this.ckjar } } catch (t) { this.logErr(t) } }).then(t => { const { statusCode: i, statusCode: r, headers: o, rawBody: a } = t, n = s.decode(a, this.encoding); e(null, { status: i, statusCode: r, headers: o, rawBody: a, body: n }, n) }, t => { const { message: i, response: r } = t; e(i, r, r && s.decode(r.rawBody, this.encoding)) }) } } post(t, e = (() => { })) { const s = t.method ? t.method.toLocaleLowerCase() : "post"; if (t.body && t.headers && !t.headers["Content-Type"] && (t.headers["Content-Type"] = "application/x-www-form-urlencoded"), t.headers && delete t.headers["Content-Length"], this.isSurge() || this.isLoon()) this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient[s](t, (t, s, i) => { !t && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, i) }); else if (this.isQuanX()) t.method = s, this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then(t => { const { statusCode: s, statusCode: i, headers: r, body: o } = t; e(null, { status: s, statusCode: i, headers: r, body: o }, o) }, t => e(t && t.error || "UndefinedError")); else if (this.isNode()) { let i = require("iconv-lite"); this.initGotEnv(t); const { url: r, ...o } = t; this.got[s](r, o).then(t => { const { statusCode: s, statusCode: r, headers: o, rawBody: a } = t, n = i.decode(a, this.encoding); e(null, { status: s, statusCode: r, headers: o, rawBody: a, body: n }, n) }, t => { const { message: s, response: r } = t; e(s, r, r && i.decode(r.rawBody, this.encoding)) }) } } time(t, e = null) { const s = e ? new Date(e) : new Date; let i = { "M+": s.getMonth() + 1, "d+": s.getDate(), "H+": s.getHours(), "m+": s.getMinutes(), "s+": s.getSeconds(), "q+": Math.floor((s.getMonth() + 3) / 3), S: s.getMilliseconds() }; /(y+)/.test(t) && (t = t.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length))); for (let e in i) new RegExp("(" + e + ")").test(t) && (t = t.replace(RegExp.$1, 1 == RegExp.$1.length ? i[e] : ("00" + i[e]).substr(("" + i[e]).length))); return t } msg(e = t, s = "", i = "", r) { const o = t => { if (!t) return t; if ("string" == typeof t) return this.isLoon() ? t : this.isQuanX() ? { "open-url": t } : this.isSurge() ? { url: t } : void 0; if ("object" == typeof t) { if (this.isLoon()) { let e = t.openUrl || t.url || t["open-url"], s = t.mediaUrl || t["media-url"]; return { openUrl: e, mediaUrl: s } } if (this.isQuanX()) { let e = t["open-url"] || t.url || t.openUrl, s = t["media-url"] || t.mediaUrl, i = t["update-pasteboard"] || t.updatePasteboard; return { "open-url": e, "media-url": s, "update-pasteboard": i } } if (this.isSurge()) { let e = t.url || t.openUrl || t["open-url"]; return { url: e } } } }; if (this.isMute || (this.isSurge() || this.isLoon() ? $notification.post(e, s, i, o(r)) : this.isQuanX() && $notify(e, s, i, o(r))), !this.isMuteLog) { let t = ["", "==============\ud83d\udce3\u7cfb\u7edf\u901a\u77e5\ud83d\udce3=============="]; t.push(e), s && t.push(s), i && t.push(i), console.log(t.join("\n")), this.logs = this.logs.concat(t) } } log(...t) { t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(t.join(this.logSeparator)) } logErr(t, e) { const s = !this.isSurge() && !this.isQuanX() && !this.isLoon(); s ? this.log("", `\u2757\ufe0f${this.name}, \u9519\u8bef!`, t.stack) : this.log("", `\u2757\ufe0f${this.name}, \u9519\u8bef!`, t) } wait(t) { return new Promise(e => setTimeout(e, t)) } done(t = {}) { const e = (new Date).getTime(), s = (e - this.startTime) / 1e3; this.log("", `\ud83d\udd14${this.name}, \u7ed3\u675f! \ud83d\udd5b ${s} \u79d2`), this.log(), this.isSurge() || this.isQuanX() || this.isLoon() ? $done(t) : this.isNode() && process.exit(1) } }(t, e) }