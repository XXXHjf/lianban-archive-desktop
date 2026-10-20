"""Allowlisted province labels; detailed locations are never valid values."""

PROVINCES = ("北京市", "天津市", "上海市", "重庆市", "河北省", "山西省", "辽宁省", "吉林省", "黑龙江省",
             "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省",
             "广东省", "海南省", "四川省", "贵州省", "云南省", "陕西省", "甘肃省", "青海省", "台湾省",
             "内蒙古自治区", "广西壮族自治区", "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区",
             "香港特别行政区", "澳门特别行政区")


def normalize_province(value):
    if not isinstance(value, str):
        return ""
    value = value.strip()
    for province in PROVINCES:
        short = province.replace("壮族自治区", "").replace("回族自治区", "").replace("维吾尔自治区", "")
        short = short.replace("自治区", "").replace("特别行政区", "").removesuffix("省").removesuffix("市")
        if value in (province, short):
            return province
    return ""
